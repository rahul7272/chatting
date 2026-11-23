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

      // Both PRESENT and ABSENT deduct 1 credit (-1)
      if (item.status === 'PRESENT' || item.status === 'ABSENT') {
        const reason = item.status === 'PRESENT' ? 'CLASS_ATTENDANCE' : 'UNEXCUSED_ABSENCE';
        await creditService.deductCreditForClass(item.studentId, attendance._id, reason);
        attendance.creditDeducted = true;

        // Teacher payout is earned ONLY for attended classes (PRESENT)
        if (item.status === 'PRESENT') {
          await payoutService.recordTeacherEarning({
            teacherId,
            studentId: item.studentId,
            groupId,
            attendanceId: attendance._id,
            classDate: new Date(classDate),
          });
          attendance.payoutCalculated = true;
        }

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
