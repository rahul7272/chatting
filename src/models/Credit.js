const mongoose = require('mongoose');

const CreditSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    delta: {
      type: Number,
      required: true, // e.g. -1 for class attended, +8 for renewal
    },
    resultingBalance: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      enum: [
        'CLASS_ATTENDANCE',
        'TOPUP_RENEWAL',
        'ADMIN_ADJUSTMENT',
        'ATTENDANCE_REVERSAL',
        'ATTENDANCE_CORRECTION',
        'INITIAL_GRANT',
      ],
      required: true,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    adjustedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

CreditSchema.index({ studentId: 1, createdAt: -1 });

module.exports = mongoose.model('Credit', CreditSchema);
