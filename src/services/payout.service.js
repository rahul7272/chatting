const TeacherLedger = require('../models/TeacherLedger');
const User = require('../models/User');

class PayoutService {
  async recordTeacherEarning({ teacherId, studentId, groupId, attendanceId }) {
    const teacher = await User.findById(teacherId);
    const commissionPercent = teacher ? (teacher.commissionPercentage || 50) : 50;

    // Formula from FRS: (Student Fee / Enrolled Classes) * Commission %
    const feePerClass = 100;
    const payoutAmount = (feePerClass * commissionPercent) / 100;

    return await TeacherLedger.create({
      teacherId,
      studentId,
      groupId,
      attendanceId,
      calculatedAmount: payoutAmount,
      commissionPercent,
      status: 'PENDING',
    });
  }

  async getTeacherLedger(teacherId) {
    return await TeacherLedger.find({ teacherId })
      .populate('studentId', 'name')
      .populate('groupId', 'title code')
      .sort({ createdAt: -1 });
  }

  async markBatchProcessed(batchId, ledgerIds) {
    return await TeacherLedger.updateMany(
      { _id: { $in: ledgerIds } },
      { status: 'PROCESSED', payoutBatchId: batchId }
    );
  }
}

module.exports = new PayoutService();
