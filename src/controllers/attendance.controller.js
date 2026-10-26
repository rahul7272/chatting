const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Group = require('../models/Group');
const Credit = require('../models/Credit');
const RenewalTask = require('../models/RenewalTask');
const TeacherLedger = require('../models/TeacherLedger');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const { ROLES } = require('../constants/roles');
const fcmService = require('../services/fcm.service');

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
      return errorResponse(res, 'Target cohort / batch not found.', statusCodes.NOT_FOUND);
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

      if (diffDays > 1) {
        return errorResponse(
          res,
          'Teachers are restricted to updating attendance for today and yesterday (last 1 day) only. Older records are locked.',
          statusCodes.FORBIDDEN
        );
      }
      if (diffDays < 0) {
        return errorResponse(
          res,
          'Attendance cannot be marked in advance for future dates.',
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

      // Check if attendance already exists for this student on this day in this group
      const startOfDay = new Date(`${dateOnlyStr}T00:00:00.000Z`);
      const endOfDay = new Date(`${dateOnlyStr}T23:59:59.999Z`);
      let attendance = await Attendance.findOne({
        groupId,
        studentId,
        classDate: { $gte: startOfDay, $lte: endOfDay },
      });

      if (attendance) {
        // UPDATE existing record
        const oldStatus = attendance.status;
        attendance.status = newStatus;
        attendance.remarks = remarks;
        attendance.markedBy = userId;

        // If changed to PRESENT from ABSENT/EXCUSED: deduct credit & calculate ledger
        if (oldStatus !== 'PRESENT' && newStatus === 'PRESENT') {
          const student = await findStudent(studentId);
          if (student) {
            const newBalance = (student.enrolledCreditBalance || 0) - 1;
            student.enrolledCreditBalance = newBalance;
            await student.save();

            await Credit.create({
              studentId: student._id,
              delta: -1,
              resultingBalance: newBalance,
              reason: 'CLASS_ATTENDANCE',
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

            // Calculate Teacher Payout
            const teacher = await findTeacher(teacherId);
            const commissionPercent = teacher ? (teacher.commissionPercentage || 50) : 50;
            const ratePerClass = 100;
            const payoutAmount = (ratePerClass * commissionPercent) / 100;

            await TeacherLedger.create({
              teacherId,
              studentId: student._id,
              groupId,
              attendanceId: attendance._id,
              calculatedAmount: payoutAmount,
              commissionPercent,
              status: 'PENDING',
            });

            attendance.creditDeducted = true;
            attendance.payoutCalculated = true;
          }
        }
        // If changed from PRESENT to ABSENT/EXCUSED: refund credit
        else if (oldStatus === 'PRESENT' && newStatus !== 'PRESENT') {
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

            await TeacherLedger.updateMany(
              { attendanceId: attendance._id },
              { status: 'CANCELLED' }
            );

            attendance.creditDeducted = false;
            attendance.payoutCalculated = false;
          }
        }

        await attendance.save();
        processedRecords.push(attendance);
      } else {
        // CREATE new attendance record
        attendance = new Attendance({
          groupId,
          studentId,
          teacherId,
          classDate: normalizedClassDate,
          status: newStatus,
          markedBy: userId,
          remarks,
        });

        if (newStatus === 'PRESENT') {
          const student = await findStudent(studentId);
          if (student) {
            const newBalance = (student.enrolledCreditBalance || 0) - 1;
            student.enrolledCreditBalance = newBalance;
            await student.save();

            await Credit.create({
              studentId: student._id,
              delta: -1,
              resultingBalance: newBalance,
              reason: 'CLASS_ATTENDANCE',
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

            const teacher = await findTeacher(teacherId);
            const commissionPercent = teacher ? (teacher.commissionPercentage || 50) : 50;
            const ratePerClass = 100;
            const payoutAmount = (ratePerClass * commissionPercent) / 100;

            await TeacherLedger.create({
              teacherId,
              studentId: student._id,
              groupId,
              attendanceId: attendance._id,
              calculatedAmount: payoutAmount,
              commissionPercent,
              status: 'PENDING',
            });

            attendance.creditDeducted = true;
            attendance.payoutCalculated = true;
          }
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

    return successResponse(
      res,
      { records: processedRecords, classDate: dateOnlyStr },
      'Attendance submitted and ledger records synchronized successfully.'
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

    const query = { groupId };
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

    return successResponse(res, {
      group: {
        id: group._id.toString(),
        _id: group._id.toString(),
        title: group.title,
        code: group.code,
        subject: group.subject,
        level: group.level,
        teacherName: group.teacherName,
        teacherId: group.teacherId,
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

    // Fetch all attendance records for this student safely
    let records = [];
    if (sIdObj) {
      records = await Attendance.find({ studentId: sIdObj })
        .populate('groupId', 'title code subject level teacherName scheduleTime scheduleDays meetUrl')
        .populate('teacherId', 'name avatarUrl phoneNumber')
        .sort({ classDate: -1 })
        .lean();
    } else {
      // For dev/mock IDs (e.g., dev_admin_id), query without strict ObjectId requirement
      try {
        const raw = await mongoose.connection.db
          .collection('attendances')
          .find({ studentId: sIdStr })
          .sort({ classDate: -1 })
          .toArray();
        records = raw || [];
      } catch (_) {
        records = [];
      }
    }

    // Fetch all groups where student is enrolled (handling both ObjectId and string studentIds)
    const queryIn = [sIdStr];
    if (sIdObj) queryIn.push(sIdObj);

    const enrolledGroups = await mongoose.connection.db
      .collection('groups')
      .find({ studentIds: { $in: queryIn }, isActive: { $ne: false } })
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
        teacherName: g.teacherName || 'Faculty',
        scheduleTime: g.scheduleTime || '',
        scheduleDays: g.scheduleDays || '',
        meetUrl: g.meetUrl || '',
        totalClasses: 0,
        presentCount: 0,
        absentCount: 0,
        excusedCount: 0,
        attendancePercentage: 100,
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
          teacherName: r.groupId.teacherName || r.teacherId?.name || 'Faculty',
          scheduleTime: r.groupId.scheduleTime || '',
          scheduleDays: r.groupId.scheduleDays || '',
          meetUrl: r.groupId.meetUrl || '',
          totalClasses: 0,
          presentCount: 0,
          absentCount: 0,
          excusedCount: 0,
          attendancePercentage: 100,
          records: [],
        };
      }

      const b = batchMap[gId];
      b.totalClasses += 1;
      if (r.status === 'PRESENT') b.presentCount += 1;
      else if (r.status === 'ABSENT') b.absentCount += 1;
      else if (r.status === 'EXCUSED') b.excusedCount += 1;
      b.attendancePercentage = b.totalClasses > 0 ? Math.round((b.presentCount / b.totalClasses) * 100) : 100;
      b.records.push({
        id: r._id.toString(),
        classDate: r.classDate,
        status: r.status,
        remarks: r.remarks || '',
        teacherName: r.teacherId?.name || r.groupId?.teacherName || 'Faculty',
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
    const attendancePercentage =
      totalClasses > 0 ? Math.round((presentCount / totalClasses) * 100) : 100;

    return successResponse(res, {
      summary: {
        totalClasses,
        presentCount,
        absentCount,
        excusedCount,
        attendancePercentage,
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
      query.groupId = groupId;
    }
    if (status && status !== 'ALL') {
      query.status = status.toUpperCase();
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
      .populate('groupId', 'title code subject teacherName')
      .populate('markedBy', 'name role')
      .sort({ classDate: -1 })
      .limit(200);

    // Calculate aggregated metrics
    const totalRecords = records.length;
    const presentCount = records.filter((r) => r.status === 'PRESENT').length;
    const absentCount = records.filter((r) => r.status === 'ABSENT').length;
    const excusedCount = records.filter((r) => r.status === 'EXCUSED').length;
    const attendanceRate = totalRecords > 0 ? Math.round((presentCount / totalRecords) * 100) : 0;

    // Fetch all active batches for filter dropdown and batch cards
    const allGroups = await Group.find({ isActive: true }).select('title code subject studentIds teacherName scheduleTime scheduleDays level meetUrl');

    return successResponse(res, {
      metrics: {
        totalRecords,
        presentCount,
        absentCount,
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
        const isEditable = diffDays >= 0 && diffDays <= 1;

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
          totalMarked: 0,
          lastMarkedAt: rec.updatedAt || rec.createdAt,
          markedByName: rec.markedBy?.name || 'Faculty',
          records: [],
        });
      }

      const session = sessionMap.get(key);
      session.totalMarked += 1;
      if (rec.status === 'PRESENT') session.presentCount += 1;
      else if (rec.status === 'ABSENT') session.absentCount += 1;
      else if (rec.status === 'EXCUSED') session.excusedCount += 1;

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
