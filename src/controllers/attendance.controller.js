const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Group = require('../models/Group');
const Credit = require('../models/Credit');
const RenewalTask = require('../models/RenewalTask');
const TeacherLedger = require('../models/TeacherLedger');
const AuditLog = require('../models/AuditLog');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const { ROLES } = require('../constants/roles');
const fcmService = require('../services/fcm.service');
const payoutService = require('../services/payout.service');

// Helper to reliably find a student across Student and User collections
const findStudent = async (id) => {
  if (!id) return null;
  let s = await Student.findById(id);
  if (!s) s = await User.findById(id);
  return s;
};

// Helper to reliably find a teacher across Teacher and User collections
const findTeacher = async (id) => {
  if (!id) return null;
  let t = await Teacher.findById(id);
  if (!t) t = await User.findById(id);
  return t;
};

// Helper to parse class start time e.g. "05:00 PM", "8 pm", "17:00", "05:00 PM - 06:00 PM"
const parseStartTime = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return { hour: 17, minute: 0 };
  const firstPart = timeStr.split('-')[0].trim();
  const match12 = firstPart.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (match12) {
    let hour = parseInt(match12[1], 10);
    const minute = match12[2] ? parseInt(match12[2], 10) : 0;
    const meridian = match12[3].toLowerCase();
    if (meridian === 'pm' && hour < 12) hour += 12;
    if (meridian === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  const match24 = firstPart.match(/^(\d{1,2}):(\d{2})/);
  if (match24) {
    return { hour: parseInt(match24[1], 10), minute: parseInt(match24[2], 10) };
  }
  return { hour: 17, minute: 0 };
};

// Status classification helpers for credit deduction:
// Deductible: PRESENT (attended) and ABSENT (unexcused absence) both deduct 1 credit (-1)
// Exempt: LEAVE and EXCUSED (approved leaves) do NOT deduct credits (0 deduction)
const isCreditDeductible = (st) => st === 'PRESENT' || st === 'ABSENT';
const isCreditExempt = (st) => st === 'LEAVE' || st === 'EXCUSED';

/**
 * 1. Mark or Update Attendance (Teacher or Admin)
 * Teacher rule: Can only mark or update attendance for today or yesterday (last 1 day).
 * Admin rule: Can mark or update attendance for any date.
 */
const markAttendance = async (req, res, next) => {
  try {
    const { groupId, classDate, records } = req.body;
    // records: [{ studentId, status: 'PRESENT' | 'ABSENT' | 'EXCUSED', remarks }]
    const userId = req.user.userId;
    const userRole = (req.user.role || '').toUpperCase();

    if (!groupId || !classDate || !Array.isArray(records)) {
      return errorResponse(res, 'groupId, classDate, and records array are required.', statusCodes.BAD_REQUEST);
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return errorResponse(res, 'Target group / batch not found.', statusCodes.NOT_FOUND);
    }

    // Normalize date to UTC midnight for consistent daily uniqueness
    const parsedDate = new Date(classDate);
    if (isNaN(parsedDate.getTime())) {
      return errorResponse(res, 'Invalid classDate format provided.', statusCodes.BAD_REQUEST);
    }
    const dateOnlyStr = parsedDate.toISOString().split('T')[0];
    const normalizedClassDate = new Date(`${dateOnlyStr}T00:00:00.000Z`);

    // RESTRICTION: Teachers can only update attendance for today or yesterday (last 1 day)
    const isTeacher = userRole === ROLES.TEACHER;
    if (isTeacher) {
      const todayStr = new Date().toISOString().split('T')[0];
      const todayDate = new Date(`${todayStr}T00:00:00.000Z`);
      const diffTime = todayDate.getTime() - normalizedClassDate.getTime();
      const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

      // Allow timezone differences (e.g. IST UTC+5:30 where local day starts up to 1 day ahead of UTC):
      // diffDays < -1 means 2 or more days in advance (genuine future date)
      if (diffDays < -1) {
        return errorResponse(
          res,
          'Attendance cannot be marked in advance for future dates.',
          statusCodes.BAD_REQUEST
        );
      }
      if (diffDays > 2) {
        return errorResponse(
          res,
          'Teachers are restricted to updating attendance for today and yesterday only. Older records are locked.',
          statusCodes.FORBIDDEN
        );
      }

      // CLASS START TIME VALIDATION:
      // Attendance cannot be marked before the scheduled class time has started!
      // (e.g. class is at 8:00 PM, but current time is 7:00 PM)
      const tz = group.schedule?.timezone || 'Asia/Kolkata';
      const now = new Date();
      const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));

      const [cYear, cMonth, cDay] = dateOnlyStr.split('-').map(Number);
      const startTimeStr = group.schedule?.startTime || '05:00 PM';
      const { hour: startHour, minute: startMinute } = parseStartTime(startTimeStr);
      const scheduledClassStart = new Date(cYear, cMonth - 1, cDay, startHour, startMinute, 0);

      if (nowInTz.getTime() < scheduledClassStart.getTime()) {
        const remainingMinutes = Math.ceil((scheduledClassStart.getTime() - nowInTz.getTime()) / 60000);
        const remHours = Math.floor(remainingMinutes / 60);
        const remMins = remainingMinutes % 60;
        const timeRemainingStr = remHours > 0 ? `${remHours}h ${remMins}m` : `${remMins}m`;

        return errorResponse(
          res,
          `Attendance cannot be marked before the scheduled class time (${startTimeStr}). Class starts in ${timeRemainingStr}.`,
          statusCodes.BAD_REQUEST
        );
      }
    }

    const teacherId = group.teacherId || userId;
    const processedRecords = [];

    for (const item of records) {
      if (!item.studentId || !item.status) continue;

      const studentId = item.studentId;
      const newStatus = item.status.toUpperCase();
      const remarks = item.remarks || '';

      const sIdStr = studentId.toString();
      const sIdObj = mongoose.Types.ObjectId.isValid(sIdStr) ? new mongoose.Types.ObjectId(sIdStr) : null;
      const sIdCandidates = [sIdStr];
      if (sIdObj) sIdCandidates.push(sIdObj);

      const gIdStr = groupId.toString();
      const gIdObj = mongoose.Types.ObjectId.isValid(gIdStr) ? new mongoose.Types.ObjectId(gIdStr) : null;
      const gIdCandidates = [gIdStr];
      if (gIdObj) gIdCandidates.push(gIdObj);

      // Check if attendance already exists for this student on this day in this group
      const startOfDay = new Date(`${dateOnlyStr}T00:00:00.000Z`);
      const endOfDay = new Date(`${dateOnlyStr}T23:59:59.999Z`);
      let attendance = await Attendance.findOne({
        groupId: { $in: gIdCandidates },
        studentId: { $in: sIdCandidates },
        classDate: { $gte: startOfDay, $lte: endOfDay },
      });

      if (attendance) {
        // UPDATE existing record
        const oldStatus = attendance.status;
        const wasDeducted = Boolean(attendance.creditDeducted);
        const isNowDeductible = isCreditDeductible(newStatus);
        const isNowExempt = isCreditExempt(newStatus);

        attendance.status = newStatus;
        attendance.remarks = remarks;
        attendance.markedBy = userId;

        // Ensure active teacher attribution is permanently stored on Attendance record
        if (!attendance.teacherId && teacherId) {
          attendance.teacherId = teacherId;
        }

        // 1. Student Credit Balance Adjustment
        // Case A: Was NOT deducted -> Now Deductible (e.g. from LEAVE/EXCUSED to PRESENT or ABSENT)
        if (!wasDeducted && isNowDeductible) {
          const student = await findStudent(studentId);
          if (student) {
            const newBalance = (student.enrolledCreditBalance || 0) - 1;
            student.enrolledCreditBalance = newBalance;
            await student.save();

            await Credit.create({
              studentId: student._id,
              delta: -1,
              resultingBalance: newBalance,
              reason: newStatus === 'PRESENT' ? 'CLASS_ATTENDANCE' : 'UNEXCUSED_ABSENCE',
              referenceId: attendance._id,
            });

            if (newBalance <= 1) {
              const existingTask = await RenewalTask.findOne({ studentId: student._id, status: 'PENDING' });
              if (!existingTask) {
                await RenewalTask.create({
                  studentId: student._id,
                  currentBalance: newBalance,
                  status: 'PENDING',
                });
              }
            }

            attendance.creditDeducted = true;

            if (mongoose.Types.ObjectId.isValid(userId)) {
              await AuditLog.create({
                actorId: userId,
                action: newStatus === 'PRESENT' ? 'ATTENDANCE_PRESENT_CREDIT_DEDUCTED' : 'ATTENDANCE_ABSENT_CREDIT_DEDUCTED',
                entity: 'Attendance',
                entityId: attendance._id,
                oldValue: { status: oldStatus, creditDeducted: false },
                newValue: { status: newStatus, creditDeducted: true },
                ipAddress: req.ip || '',
                userAgent: req.get('user-agent') || '',
              }).catch(() => null);
            }
          }
        }
        // Case B: Was Deducted -> Now Exempt (e.g. from PRESENT or ABSENT to LEAVE or EXCUSED)
        else if (wasDeducted && isNowExempt) {
          const student = await findStudent(studentId);
          if (student) {
            const newBalance = (student.enrolledCreditBalance || 0) + 1;
            student.enrolledCreditBalance = newBalance;
            await student.save();

            await Credit.create({
              studentId: student._id,
              delta: +1,
              resultingBalance: newBalance,
              reason: 'ATTENDANCE_CORRECTION',
              referenceId: attendance._id,
            });

            attendance.creditDeducted = false;

            if (mongoose.Types.ObjectId.isValid(userId)) {
              await AuditLog.create({
                actorId: userId,
                action: 'ATTENDANCE_EXEMPT_CREDIT_REFUNDED',
                entity: 'Attendance',
                entityId: attendance._id,
                oldValue: { status: oldStatus, creditDeducted: true },
                newValue: { status: newStatus, creditDeducted: false },
                ipAddress: req.ip || '',
                userAgent: req.get('user-agent') || '',
              }).catch(() => null);
            }
          }
        }
        // Case C: Between deductibles (PRESENT <-> ABSENT)
        // 1 credit was already deducted for this session; balance does not change.

        // 2. Teacher Compensation Lifecycle
        // Teacher earns payout ONLY for attended classes (PRESENT)
        if (newStatus === 'PRESENT') {
          const activeTeacherId = attendance.teacherId || teacherId;
          await payoutService.recordTeacherEarning({
            teacherId: activeTeacherId,
            studentId,
            groupId,
            attendanceId: attendance._id,
            classDate: normalizedClassDate,
          });
          attendance.payoutCalculated = true;

          if (oldStatus !== 'PRESENT' && mongoose.Types.ObjectId.isValid(userId)) {
            await AuditLog.create({
              actorId: userId,
              action: 'ATTENDANCE_MARKED_PRESENT_PAYOUT_GENERATED',
              entity: 'Attendance',
              entityId: attendance._id,
              oldValue: { status: oldStatus },
              newValue: { status: newStatus, payoutStatus: 'PENDING' },
              ipAddress: req.ip || '',
              userAgent: req.get('user-agent') || '',
            }).catch(() => null);
          }
        } else if (oldStatus === 'PRESENT' && newStatus !== 'PRESENT') {
          // Switching from PRESENT to ABSENT or LEAVE/EXCUSED: reverse the teacher payout
          await payoutService.reverseTeacherEarning(attendance._id, 'ATTENDANCE_CORRECTION');
          attendance.payoutCalculated = false;

          if (mongoose.Types.ObjectId.isValid(userId)) {
            await AuditLog.create({
              actorId: userId,
              action: 'ATTENDANCE_CORRECTION_PAYOUT_REVERSED',
              entity: 'Attendance',
              entityId: attendance._id,
              oldValue: { status: oldStatus, payoutStatus: 'PENDING' },
              newValue: { status: newStatus, payoutStatus: 'REVERSED' },
              ipAddress: req.ip || '',
              userAgent: req.get('user-agent') || '',
            }).catch(() => null);
          }
        }

        await attendance.save();
        processedRecords.push(attendance);
      } else {
        // CREATE new attendance record
        attendance = new Attendance({
          groupId: gIdObj || gIdStr,
          studentId: sIdObj || sIdStr,
          teacherId,
          classDate: normalizedClassDate,
          status: newStatus,
          markedBy: userId,
          remarks,
        });

        // If PRESENT or ABSENT: cut 1 credit from student
        if (isCreditDeductible(newStatus)) {
          const student = await findStudent(studentId);
          if (student) {
            const newBalance = (student.enrolledCreditBalance || 0) - 1;
            student.enrolledCreditBalance = newBalance;
            await student.save();

            await Credit.create({
              studentId: student._id,
              delta: -1,
              resultingBalance: newBalance,
              reason: newStatus === 'PRESENT' ? 'CLASS_ATTENDANCE' : 'UNEXCUSED_ABSENCE',
              referenceId: attendance._id,
            });

            if (newBalance <= 1) {
              const existingTask = await RenewalTask.findOne({ studentId: student._id, status: 'PENDING' });
              if (!existingTask) {
                await RenewalTask.create({
                  studentId: student._id,
                  currentBalance: newBalance,
                  status: 'PENDING',
                });
              }
            }

            attendance.creditDeducted = true;

            // Teacher payout is earned ONLY when student is PRESENT
            if (newStatus === 'PRESENT') {
              const activeTeacherId = attendance.teacherId || teacherId;
              await payoutService.recordTeacherEarning({
                teacherId: activeTeacherId,
                studentId: student._id,
                groupId,
                attendanceId: attendance._id,
                classDate: normalizedClassDate,
              });
              attendance.payoutCalculated = true;
            } else {
              attendance.payoutCalculated = false;
            }

            // Audit log the attendance creation
            if (mongoose.Types.ObjectId.isValid(userId)) {
              await AuditLog.create({
                actorId: userId,
                action: newStatus === 'PRESENT'
                  ? 'ATTENDANCE_MARKED_PRESENT_PAYOUT_GENERATED'
                  : 'ATTENDANCE_MARKED_ABSENT_CREDIT_DEDUCTED',
                entity: 'Attendance',
                entityId: attendance._id,
                oldValue: null,
                newValue: { status: newStatus, creditDeducted: true, payoutStatus: newStatus === 'PRESENT' ? 'PENDING' : 'NONE' },
                ipAddress: req.ip || '',
                userAgent: req.get('user-agent') || '',
              }).catch(() => null);
            }
          }
        } else {
          // Approved LEAVE or EXCUSED: 0 credit cut, 0 payout
          attendance.creditDeducted = false;
          attendance.payoutCalculated = false;
        }

        await attendance.save();
        processedRecords.push(attendance);
      }
    }

    // Dispatch Native Push Notifications (FCM) to marked students
    try {
      for (const rec of processedRecords) {
        fcmService.sendAttendanceNotification({
          studentId: rec.studentId,
          status: rec.status,
          batchTitle: group.title,
          classDate: dateOnlyStr,
        }).catch(() => {});
      }
    } catch (_) {}

    // Dispatch real-time WebSocket events to update all student dashboards and profiles instantly
    try {
      const { broadcast, broadcastToUsers } = require('../config/socket');
      const studentIdsList = processedRecords.map((r) => r.studentId?.toString()).filter(Boolean);
      broadcast('attendance_updated', {
        groupId: groupId.toString(),
        classDate: dateOnlyStr,
        recordsCount: processedRecords.length,
      }, groupId.toString());
      if (studentIdsList.length > 0) {
        broadcastToUsers('attendance_updated', {
          groupId: groupId.toString(),
          classDate: dateOnlyStr,
        }, studentIdsList);
      }
    } catch (_) {}

    const presentCount = processedRecords.filter((r) => r.status === 'PRESENT').length;
    const absentCount = processedRecords.filter((r) => r.status === 'ABSENT').length;
    const leaveCount = processedRecords.filter((r) => r.status === 'LEAVE' || r.status === 'EXCUSED').length;
    const totalCount = processedRecords.length;

    return successResponse(
      res,
      {
        records: processedRecords,
        classDate: dateOnlyStr,
        summary: {
          presentCount,
          absentCount,
          leaveCount,
          totalCount,
          classDate: dateOnlyStr,
          batchTitle: group.title,
        },
      },
      `Attendance marked successfully: ${presentCount} Present, ${absentCount} Absent, ${leaveCount} Leave (${totalCount} total).`
    );
  } catch (err) {
    next(err);
  }
};

/**
 * 2. Get attendance for a specific Group/Batch
 * Optional query: ?date=YYYY-MM-DD
 */
const getGroupAttendance = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { date } = req.query;

    const group = await Group.findById(groupId).lean();
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    // Reliably resolve all enrolled students with their current enrolledCreditBalance
    const rawStudentIds = Array.isArray(group.studentIds) ? group.studentIds : [];
    const resolvedStudents = [];
    for (const item of rawStudentIds) {
      const sId = (item?._id || item || '').toString();
      if (!sId) continue;
      const sDoc = await findStudent(sId);
      if (sDoc) {
        resolvedStudents.push({
          _id: sDoc._id.toString(),
          id: sDoc._id.toString(),
          name: sDoc.name || 'Student',
          phoneNumber: sDoc.phoneNumber || sDoc.phone || '',
          email: sDoc.email || '',
          avatarUrl: sDoc.avatarUrl || sDoc.avatar || '',
          enrolledCreditBalance: sDoc.enrolledCreditBalance ?? 0,
          studentLevel: sDoc.studentLevel || 'Beginner',
        });
      } else {
        resolvedStudents.push({
          _id: sId,
          id: sId,
          name: 'Student',
          phoneNumber: '',
          email: '',
          avatarUrl: '',
          enrolledCreditBalance: 0,
          studentLevel: 'Beginner',
        });
      }
    }

    const gIdStr = groupId.toString();
    const gIdObj = mongoose.Types.ObjectId.isValid(gIdStr) ? new mongoose.Types.ObjectId(gIdStr) : null;
    const gIdCandidates = [gIdStr];
    if (gIdObj) gIdCandidates.push(gIdObj);

    const query = { groupId: { $in: gIdCandidates } };
    if (date) {
      const parsed = new Date(date);
      if (!isNaN(parsed.getTime())) {
        const dateStr = parsed.toISOString().split('T')[0];
        const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
        const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);
        query.classDate = { $gte: startOfDay, $lte: endOfDay };
      }
    }

    const rawHistory = await Attendance.find(query)
      .sort({ classDate: -1 })
      .lean();

    // Map history and reliably resolve student and markedBy details
    const history = await Promise.all(
      rawHistory.map(async (rec) => {
        const sId = (rec.studentId?._id || rec.studentId || '').toString();
        let stObj = resolvedStudents.find((s) => s._id === sId || s.id === sId);
        if (!stObj && sId) {
          const sDoc = await findStudent(sId);
          if (sDoc) {
            stObj = {
              _id: sDoc._id.toString(),
              id: sDoc._id.toString(),
              name: sDoc.name || 'Student',
              phoneNumber: sDoc.phoneNumber || sDoc.phone || '',
              email: sDoc.email || '',
              avatarUrl: sDoc.avatarUrl || sDoc.avatar || '',
              enrolledCreditBalance: sDoc.enrolledCreditBalance ?? 0,
            };
          }
        }
        if (!stObj) {
          stObj = { _id: sId, id: sId, name: 'Student', enrolledCreditBalance: 0 };
        }

        // Resolve who marked it (Teacher or Admin)
        let markedByObj = null;
        if (rec.markedBy) {
          const mbId = (rec.markedBy._id || rec.markedBy || '').toString();
          if (mbId === 'dev_admin_id' || mbId.toLowerCase().includes('admin')) {
            markedByObj = { _id: mbId, name: 'Admin', role: 'ADMIN' };
          } else if (mongoose.Types.ObjectId.isValid(mbId)) {
            const tDoc = await findTeacher(mbId);
            if (tDoc) {
              markedByObj = { _id: mbId, name: tDoc.name, role: 'TEACHER' };
            } else {
              const uDoc = await User.findById(mbId).lean().catch(() => null);
              if (uDoc) {
                markedByObj = { _id: mbId, name: uDoc.name, role: uDoc.role || 'ADMIN' };
              } else {
                markedByObj = { _id: mbId, name: 'Admin', role: 'ADMIN' };
              }
            }
          } else {
            markedByObj = { _id: mbId, name: 'Admin', role: 'ADMIN' };
          }
        }

        return {
          ...rec,
          id: (rec._id || '').toString(),
          _id: (rec._id || '').toString(),
          studentId: stObj,
          markedBy: markedByObj,
          creditDeducted: Boolean(rec.creditDeducted),
        };
      })
    );

    const teacherDoc = group.teacherId ? await findTeacher(group.teacherId) : null;

    return successResponse(res, {
      group: {
        id: group._id.toString(),
        _id: group._id.toString(),
        title: group.title,
        code: group.code,
        subject: group.subject,
        level: group.level,
        avatar: group.avatar || group.profilePic || group.avatarUrl || '',
        avatarUrl: group.avatar || group.profilePic || group.avatarUrl || '',
        profilePic: group.avatar || group.profilePic || group.avatarUrl || '',
        teacherName: group.teacherName || teacherDoc?.name || 'Teacher',
        teacherId: group.teacherId,
        teacherAvatar: teacherDoc?.avatarUrl || '',
        teacherAvatarUrl: teacherDoc?.avatarUrl || '',
        scheduleTime: group.scheduleTime,
        scheduleDays: group.scheduleDays,
        meetUrl: group.meetUrl,
        students: resolvedStudents,
        studentIds: resolvedStudents,
      },
      history,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 3. Student view: Get logged-in student's personal attendance summary & history
 */
const getMyAttendance = async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const studentId = req.user.userId;
    const sIdStr = (studentId || '').toString();
    const sIdObj = mongoose.Types.ObjectId.isValid(sIdStr) ? new mongoose.Types.ObjectId(sIdStr) : null;

    // Fetch all attendance records for this student safely across both String and ObjectId representations
    const candidateStudentIds = [sIdStr];
    if (sIdObj) candidateStudentIds.push(sIdObj);

    try {
      const studentDoc = await findStudent(studentId);
      if (studentDoc && studentDoc._id) {
        const docIdStr = studentDoc._id.toString();
        if (!candidateStudentIds.includes(docIdStr)) candidateStudentIds.push(docIdStr);
        if (mongoose.Types.ObjectId.isValid(docIdStr)) {
          const docIdObj = new mongoose.Types.ObjectId(docIdStr);
          if (!candidateStudentIds.some((x) => typeof x === 'object' && x.toString() === docIdStr)) {
            candidateStudentIds.push(docIdObj);
          }
        }
      }
    } catch (_) {}

    let records = [];
    try {
      records = await Attendance.find({ studentId: { $in: candidateStudentIds } })
        .populate('groupId', 'title code subject level teacherName scheduleTime scheduleDays meetUrl')
        .populate('teacherId', 'name avatarUrl phoneNumber')
        .sort({ classDate: -1 })
        .lean();
    } catch (_) {
      try {
        const raw = await mongoose.connection.db
          .collection('attendances')
          .find({ studentId: { $in: candidateStudentIds } })
          .sort({ classDate: -1 })
          .toArray();
        records = raw || [];
      } catch (_) {
        records = [];
      }
    }

    // Fetch all groups where student is enrolled (handling both ObjectId and string studentIds)
    const enrolledGroups = await mongoose.connection.db
      .collection('groups')
      .find({ studentIds: { $in: candidateStudentIds }, isActive: { $ne: false } })
      .toArray();

    // Map each batch with its complete attendance details
    const batchMap = {};

    enrolledGroups.forEach((g) => {
      const gId = g._id.toString();
      batchMap[gId] = {
        groupId: gId,
        id: gId,
        title: g.title || 'Class Batch',
        code: g.code || '',
        subject: g.subject || '',
        level: g.level || '',
        teacherName: g.teacherName || 'Teacher',
        scheduleTime: g.scheduleTime || '',
        scheduleDays: g.scheduleDays || '',
        meetUrl: g.meetUrl || '',
        avatar: g.avatar || g.avatarUrl || g.groupPic || '',
        avatarUrl: g.avatar || g.avatarUrl || g.groupPic || '',
        totalClasses: 0,
        presentCount: 0,
        absentCount: 0,
        excusedCount: 0,
        leaveCount: 0,
        attendancePercentage: 0,
        records: [],
      };
    });

    records.forEach((r) => {
      if (!r.groupId) return;
      const gId = (r.groupId._id || r.groupId).toString();
      if (!batchMap[gId]) {
        batchMap[gId] = {
          groupId: gId,
          id: gId,
          title: r.groupId.title || 'Class Batch',
          code: r.groupId.code || '',
          subject: r.groupId.subject || '',
          level: r.groupId.level || '',
          teacherName: r.groupId.teacherName || r.teacherId?.name || 'Teacher',
          scheduleTime: r.groupId.scheduleTime || '',
          scheduleDays: r.groupId.scheduleDays || '',
          meetUrl: r.groupId.meetUrl || '',
          avatar: r.groupId.avatar || r.groupId.avatarUrl || '',
          avatarUrl: r.groupId.avatar || r.groupId.avatarUrl || '',
          totalClasses: 0,
          presentCount: 0,
          absentCount: 0,
          excusedCount: 0,
          leaveCount: 0,
          attendancePercentage: 0,
          records: [],
        };
      }

      const b = batchMap[gId];
      b.totalClasses += 1;
      if (r.status === 'PRESENT') b.presentCount += 1;
      else if (r.status === 'ABSENT') b.absentCount += 1;
      else if (r.status === 'EXCUSED' || r.status === 'LEAVE') {
        b.excusedCount += 1;
        b.leaveCount += 1;
      }
      b.attendancePercentage = b.totalClasses > 0 ? Math.round((b.presentCount / b.totalClasses) * 100) : 0;
      b.records.push({
        id: r._id.toString(),
        classDate: r.classDate,
        status: r.status,
        remarks: r.remarks || '',
        teacherName: r.teacherId?.name || r.groupId?.teacherName || 'Teacher',
        teacherAvatar: r.teacherId?.avatarUrl || '',
        batchTitle: r.groupId?.title || b.title,
        subject: r.groupId?.subject || b.subject,
      });
    });

    const batches = Object.values(batchMap);

    const totalClasses = records.length;
    const presentCount = records.filter((r) => r.status === 'PRESENT').length;
    const absentCount = records.filter((r) => r.status === 'ABSENT').length;
    const excusedCount = records.filter((r) => r.status === 'EXCUSED').length;
    const leaveCount = records.filter((r) => r.status === 'LEAVE').length;
    const attendancePercentage =
      totalClasses > 0 ? Math.round((presentCount / totalClasses) * 100) : 0;

    return successResponse(res, {
      summary: {
        totalClasses,
        presentCount,
        attended: presentCount,
        absentCount,
        absent: absentCount,
        excusedCount,
        leaveCount,
        attendancePercentage,
        percentage: attendancePercentage,
        enrolledBatchesCount: batches.length,
      },
      batches,
      records,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 4. Admin view: Global attendance overview across all batches with metrics & filters
 */
const getAdminOverview = async (req, res, next) => {
  try {
    const { groupId, date, search, status } = req.query;

    const query = {};
    if (groupId && groupId !== 'ALL') {
      const gIdStr = groupId.toString();
      const gIdObj = mongoose.Types.ObjectId.isValid(gIdStr) ? new mongoose.Types.ObjectId(gIdStr) : null;
      const gIdCandidates = [gIdStr];
      if (gIdObj) gIdCandidates.push(gIdObj);
      query.groupId = { $in: gIdCandidates };
    }
    if (status && status !== 'ALL') {
      const upperStatus = status.toUpperCase();
      if (upperStatus === 'LEAVE' || upperStatus === 'EXCUSED') {
        query.status = { $in: ['LEAVE', 'EXCUSED'] };
      } else {
        query.status = upperStatus;
      }
    }
    if (date) {
      const parsed = new Date(date);
      if (!isNaN(parsed.getTime())) {
        const dateStr = parsed.toISOString().split('T')[0];
        const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
        const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);
        query.classDate = { $gte: startOfDay, $lte: endOfDay };
      }
    }

    const records = await Attendance.find(query)
      .populate('studentId', 'name phoneNumber email avatarUrl enrolledCreditBalance')
      .populate('groupId', 'title code subject teacherName avatar avatarUrl profilePic icon')
      .populate('teacherId', 'name avatarUrl phoneNumber')
      .populate('markedBy', 'name role')
      .sort({ classDate: -1 })
      .limit(1000);

    // Calculate aggregated metrics
    const totalRecords = records.length;
    const presentCount = records.filter((r) => r.status === 'PRESENT').length;
    const absentCount = records.filter((r) => r.status === 'ABSENT').length;
    const leaveCount = records.filter((r) => r.status === 'LEAVE' || r.status === 'EXCUSED').length;
    const excusedCount = leaveCount;
    const attendanceRate = totalRecords > 0 ? Math.round((presentCount / totalRecords) * 100) : 0;

    // Fetch all active batches for filter dropdown and batch cards with populated teacher & avatar
    const rawGroups = await Group.find({ isActive: true })
      .populate('teacherId', 'name avatarUrl phoneNumber')
      .lean();

    const allGroups = rawGroups.map((g) => ({
      ...g,
      id: g._id ? g._id.toString() : '',
      avatar: g.avatar || g.profilePic || g.avatarUrl || '',
      avatarUrl: g.avatar || g.profilePic || g.avatarUrl || '',
      profilePic: g.avatar || g.profilePic || g.avatarUrl || '',
      teacherAvatar: g.teacherId?.avatarUrl || '',
      teacherAvatarUrl: g.teacherId?.avatarUrl || '',
    }));

    return successResponse(res, {
      metrics: {
        totalRecords,
        presentCount,
        absentCount,
        leaveCount,
        excusedCount,
        attendanceRate,
      },
      records,
      groups: allGroups,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 5. Teacher view: Get list of already marked attendance sessions for assigned classes
 */
const getTeacherHistory = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const userRole = (req.user.role || '').toUpperCase();

    // Find all groups assigned to or taught by this teacher (or all active groups if Admin)
    let groupFilter = {};
    const isUserIdValid = mongoose.Types.ObjectId.isValid(userId);
    const userIdObj = isUserIdValid ? new mongoose.Types.ObjectId(userId) : null;

    if (userRole === ROLES.TEACHER) {
      groupFilter = {
        $or: [
          ...(userIdObj ? [{ teacherId: userIdObj }, { instructors: userIdObj }] : []),
          { teacherName: req.user.name || '' },
        ],
      };
    }

    const teacherGroups = await Group.find(groupFilter).select('_id title code subject level studentIds');
    const groupIds = teacherGroups.map((g) => g._id);

    // Also include any groups where this user explicitly marked attendance
    const orConditions = [];
    if (groupIds.length > 0) {
      orConditions.push({ groupId: { $in: groupIds } });
    }
    orConditions.push({ markedBy: userId });
    if (userIdObj) {
      orConditions.push({ teacherId: userIdObj });
    }

    const attendanceQuery = orConditions.length > 0 ? { $or: orConditions } : {};

    const records = await Attendance.find(attendanceQuery)
      .populate('groupId', 'title code subject level studentIds')
      .populate('studentId', 'name avatarUrl phoneNumber')
      .populate('markedBy', 'name role')
      .sort({ classDate: -1, createdAt: -1 });

    // Group individual student records into class session summaries: key = groupId + '_' + dateStr
    const sessionMap = new Map();
    const todayStr = new Date().toISOString().split('T')[0];
    const todayMidnight = new Date(`${todayStr}T00:00:00.000Z`);

    for (const rec of records) {
      if (!rec.groupId || !rec.classDate) continue;

      const gId = rec.groupId._id ? rec.groupId._id.toString() : rec.groupId.toString();
      const dateStr = rec.classDate.toISOString().split('T')[0];
      const key = `${gId}_${dateStr}`;

      if (!sessionMap.has(key)) {
        const recMidnight = new Date(`${dateStr}T00:00:00.000Z`);
        const diffDays = Math.round((todayMidnight.getTime() - recMidnight.getTime()) / (1000 * 3600 * 24));
        const isEditable = diffDays >= -1 && diffDays <= 2;

        sessionMap.set(key, {
          groupId: gId,
          groupTitle: rec.groupId.title || 'Class Batch',
          subject: rec.groupId.subject || '',
          level: rec.groupId.level || '',
          studentIds: rec.groupId.studentIds || [],
          totalEnrolled: (rec.groupId.studentIds || []).length,
          classDate: dateStr,
          rawDate: rec.classDate,
          isEditable,
          isToday: diffDays === 0,
          isYesterday: diffDays === 1,
          presentCount: 0,
          absentCount: 0,
          excusedCount: 0,
          leaveCount: 0,
          totalMarked: 0,
          lastMarkedAt: rec.updatedAt || rec.createdAt,
          markedByName: rec.markedBy?.name || 'Teacher',
          records: [],
        });
      }

      const session = sessionMap.get(key);
      session.totalMarked += 1;
      if (rec.status === 'PRESENT') session.presentCount += 1;
      else if (rec.status === 'ABSENT') session.absentCount += 1;
      else if (rec.status === 'EXCUSED' || rec.status === 'LEAVE') {
        session.excusedCount += 1;
        session.leaveCount += 1;
      }

      session.records.push({
        studentId: rec.studentId?._id || rec.studentId,
        studentName: rec.studentId?.name || 'Student',
        studentAvatar: rec.studentId?.avatarUrl || '',
        status: rec.status,
        remarks: rec.remarks || '',
      });
    }

    const sessions = Array.from(sessionMap.values());

    // Compute which groups have already been marked today
    const todayMarkedGroupIds = [];
    const todayMarkedSessions = {};

    for (const s of sessions) {
      if (s.isToday) {
        todayMarkedGroupIds.push(s.groupId);
        todayMarkedSessions[s.groupId] = {
          presentCount: s.presentCount,
          absentCount: s.absentCount,
          excusedCount: s.excusedCount,
          totalMarked: s.totalMarked,
        };
      }
    }

    return successResponse(res, {
      sessions,
      totalSessions: sessions.length,
      todayMarkedGroupIds,
      todayMarkedSessions,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  markAttendance,
  getGroupAttendance,
  getMyAttendance,
  getAdminOverview,
  getTeacherHistory,
};
