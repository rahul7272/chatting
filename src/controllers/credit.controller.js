const mongoose = require('mongoose');
const Credit = require('../models/Credit');
const User = require('../models/User');
const Student = require('../models/Student');
const RenewalTask = require('../models/RenewalTask');
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
    const [history, student] = await Promise.all([
      Credit.find({ studentId }).sort({ createdAt: -1 }),
      findStudent(studentId),
    ]);

    if (!student) {
      return errorResponse(res, 'Student not found.', statusCodes.NOT_FOUND);
    }

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

