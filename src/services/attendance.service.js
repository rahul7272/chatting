const Attendance = require('../models/Attendance');
const User = require('../models/User');
const creditService = require('./credit.service');
const payoutService = require('./payout.service');

class AttendanceService {
  async processClassAttendance({ groupId, teacherId, classDate, records }) {
    const results = [];

    for (const item of records) {
      const attendance = await Attendance.create({
        groupId,
        studentId: item.studentId,
        teacherId,
        classDate: new Date(classDate),
        status: item.status,
        markedBy: teacherId,
      });

      if (item.status === 'PRESENT') {
        // 1. Deduct student credit
        await creditService.deductCreditForClass(item.studentId, attendance._id);
        attendance.creditDeducted = true;

        // 2. Compute and log teacher payout
        await payoutService.recordTeacherEarning({
          teacherId,
          studentId: item.studentId,
          groupId,
          attendanceId: attendance._id,
        });
        attendance.payoutCalculated = true;

        await attendance.save();
      }

      results.push(attendance);
    }

    return results;
  }

  async getBatchAttendance(groupId) {
    return await Attendance.find({ groupId })
      .populate('studentId', 'name phoneNumber avatarUrl')
      .sort({ classDate: -1 });
  }
}

module.exports = new AttendanceService();
