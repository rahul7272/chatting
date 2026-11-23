const mongoose = require('mongoose');
const Credit = require('../models/Credit');
const User = require('../models/User');
const Student = require('../models/Student');
const RenewalTask = require('../models/RenewalTask');
const Attendance = require('../models/Attendance');
const Group = require('../models/Group');
const Teacher = require('../models/Teacher');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

// Helper to reliably locate student in Student or User model
const findStudent = async (id) => {
  if (!id) return null;
  let s = await Student.findById(id);
  if (!s) s = await User.findById(id);
  return s;
};

const getStudentCredits = async (req, res, next) => {
  try {
    const studentId = req.params.studentId || req.user.userId;
    const student = await findStudent(studentId);

    if (!student) {
      return errorResponse(res, 'Student not found.', statusCodes.NOT_FOUND);
    }

    const targetIds = [student._id];
    if (studentId && !targetIds.some(id => id.toString() === studentId.toString())) {
      targetIds.push(studentId);
    }
    try {
      if (student.phone) {
        const alt = student.constructor.modelName === 'Student'
          ? await User.findOne({ phone: student.phone }).select('_id')
          : await Student.findOne({ phone: student.phone }).select('_id');
        if (alt && !targetIds.some(id => id.toString() === alt._id.toString())) {
          targetIds.push(alt._id);
        }
      }
    } catch (_) {}

    const rawHistory = await Credit.find({ studentId: { $in: targetIds } })
      .sort({ createdAt: -1 })
      .lean();

    // Collect all valid Attendance reference IDs
    const attendanceIds = rawHistory
      .map(h => h.referenceId)
      .filter(id => id && mongoose.Types.ObjectId.isValid(id));

    const attendanceMap = {};
    if (attendanceIds.length > 0) {
      const attendances = await Attendance.find({ _id: { $in: attendanceIds } })
        .populate('groupId', 'title code subject')
        .populate('teacherId', 'name')
        .lean();

      // Check for teachers stored in User model as fallback
      const unresolvedTeacherIds = [];
      for (const att of attendances) {
        if (att.teacherId && (!att.teacherId.name || typeof att.teacherId === 'string')) {
          unresolvedTeacherIds.push(att.teacherId._id || att.teacherId);
        }
      }

      let userTeacherMap = {};
      if (unresolvedTeacherIds.length > 0) {
        const users = await User.find({ _id: { $in: unresolvedTeacherIds } }).select('name').lean();
        for (const u of users) {
          userTeacherMap[u._id.toString()] = u.name;
        }
      }

      for (const att of attendances) {
        let tName = '';
        if (att.teacherId && typeof att.teacherId === 'object' && att.teacherId.name) {
          tName = att.teacherId.name;
        } else if (att.teacherId) {
          const tIdStr = (att.teacherId._id || att.teacherId).toString();
          tName = userTeacherMap[tIdStr] || '';
        }

        const grp = att.groupId && typeof att.groupId === 'object' ? att.groupId : {};
        attendanceMap[att._id.toString()] = {
          batchName: grp.title || grp.name || '',
          subject: grp.subject || '',
          batchCode: grp.code || '',
          teacherName: tName,
          sessionTime: att.sessionTime || '',
          classDate: att.classDate || null,
          status: att.status || '',
        };
      }
    }

    const history = rawHistory.map(item => {
      const classDetails = item.referenceId ? attendanceMap[item.referenceId.toString()] || null : null;
      return {
        ...item,
        classDetails,
      };
    });

    return successResponse(res, {
      studentId: student._id,
      name: student.name,
      balance: student.enrolledCreditBalance ?? 0,
      history,
    });
  } catch (err) {
    next(err);
  }
};

const adjustCredits = async (req, res, next) => {
  try {
    const { studentId, delta, reason, notes } = req.body;
    const adjustedBy = req.user?.userId && mongoose.Types.ObjectId.isValid(req.user.userId)
      ? req.user.userId
      : null;

    if (!studentId || delta === undefined || !reason) {
      return errorResponse(res, 'studentId, delta, and reason are required.', statusCodes.BAD_REQUEST);
    }

    const student = await findStudent(studentId);
    if (!student) {
      return errorResponse(res, 'Student not found.', statusCodes.NOT_FOUND);
    }

    const newBalance = (student.enrolledCreditBalance || 0) + Number(delta);
    student.enrolledCreditBalance = newBalance;
    await student.save();

    // Keep corresponding account in other collection in sync if exists
    try {
      const otherAccount = student.constructor.modelName === 'Student'
        ? await User.findById(studentId)
        : await Student.findById(studentId);
      if (otherAccount) {
        otherAccount.enrolledCreditBalance = newBalance;
        await otherAccount.save();
      }
    } catch (_) {}

    const record = await Credit.create({
      studentId: student._id,
      delta: Number(delta),
      resultingBalance: newBalance,
      reason,
      adjustedBy,
      notes: notes || '',
    });

    // If topup renewed and balance > 1, resolve pending renewal task
    if (newBalance > 1) {
      await RenewalTask.updateMany(
        { studentId: student._id, status: 'PENDING' },
        { status: 'RENEWED', lastFollowUpAt: new Date() }
      );
    }

    return successResponse(res, { record, currentBalance: newBalance, student }, 'Credits successfully adjusted.');
  } catch (err) {
    next(err);
  }
};

const getAllTransactions = async (req, res, next) => {
  try {
    const { limit = 60 } = req.query;
    const history = await Credit.find()
      .populate('studentId', 'name email phoneNumber enrollmentNo instruments')
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    return successResponse(res, { transactions: history });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getStudentCredits,
  adjustCredits,
  getAllTransactions,
};

