const User = require('../models/User');
const Group = require('../models/Group');
const Attendance = require('../models/Attendance');
const RenewalTask = require('../models/RenewalTask');
const TeacherLedger = require('../models/TeacherLedger');
const AuditLog = require('../models/AuditLog');
const { successResponse } = require('../utils/response');

const getDashboardStats = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalStudents,
      totalTeachers,
      totalGroups,
      pendingRenewals,
      todayAttendanceCount,
      pendingPayoutCount,
    ] = await Promise.all([
      User.countDocuments({ role: 'STUDENT', isActive: true }),
      User.countDocuments({ role: 'TEACHER', isActive: true }),
      Group.countDocuments({ isActive: true }),
      RenewalTask.countDocuments({ status: 'PENDING' }),
      Attendance.countDocuments({ classDate: { $gte: today } }),
      TeacherLedger.countDocuments({ status: 'PENDING' }),
    ]);

    return successResponse(res, {
      stats: {
        totalStudents,
        totalTeachers,
        totalGroups,
        pendingRenewals,
        todayAttendanceCount,
        pendingPayoutCount,
      },
    });
  } catch (err) {
    next(err);
  }
};

const getAuditLogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const logs = await AuditLog.find()
      .populate('actorId', 'name email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    return successResponse(res, { logs });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getDashboardStats,
  getAuditLogs,
};
