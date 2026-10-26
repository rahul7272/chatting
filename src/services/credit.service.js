const Credit = require('../models/Credit');
const User = require('../models/User');
const RenewalTask = require('../models/RenewalTask');

class CreditService {
  async deductCreditForClass(studentId, attendanceId) {
    const student = await User.findById(studentId);
    if (!student) return;

    const newBalance = (student.enrolledCreditBalance || 0) - 1;
    student.enrolledCreditBalance = newBalance;
    await student.save();

    await Credit.create({
      studentId: student._id,
      delta: -1,
      resultingBalance: newBalance,
      reason: 'CLASS_ATTENDANCE',
      referenceId: attendanceId,
    });

    // Check low-credit threshold (<= 1) to create Renewal Task
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

    return newBalance;
  }

  async adjustStudentCredits({ studentId, delta, reason, adjustedBy, notes }) {
    const student = await User.findById(studentId);
    if (!student) throw new Error('Student not found');

    const newBalance = (student.enrolledCreditBalance || 0) + Number(delta);
    student.enrolledCreditBalance = newBalance;
    await student.save();

    const record = await Credit.create({
      studentId,
      delta: Number(delta),
      resultingBalance: newBalance,
      reason,
      adjustedBy,
      notes,
    });

    if (newBalance > 1) {
      await RenewalTask.updateMany(
        { studentId, status: 'PENDING' },
        { status: 'RENEWED', lastFollowUpAt: new Date() }
      );
    }

    return { record, newBalance };
  }

  async getStudentBalanceAndHistory(studentId) {
    const [user, history] = await Promise.all([
      User.findById(studentId).select('name enrolledCreditBalance'),
      Credit.find({ studentId }).sort({ createdAt: -1 }),
    ]);

    return {
      balance: user ? user.enrolledCreditBalance : 0,
      history,
    };
  }
}

module.exports = new CreditService();
