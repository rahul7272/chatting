const mongoose = require('mongoose');

const TeacherLedgerSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Teacher',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Student',
      required: true,
      index: true,
    },
    groupId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Group',
      required: true,
      index: true,
    },
    attendanceId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Attendance',
      required: true,
      unique: true,
      index: true,
    },
    // Student Package Fee (e.g. 800)
    studentFee: {
      type: Number,
      default: 800,
    },
    // Total classes enrolled in package (e.g. 8)
    totalPackageClasses: {
      type: Number,
      default: 8,
    },
    // Effective fee per class = (studentFee / totalPackageClasses) (e.g. 100)
    effectiveClassFee: {
      type: Number,
      default: 100,
    },
    // Payout Model: 'COMMISSION' (Revenue Share %) vs 'CLASS_RATE' (Fixed Rate ₹)
    payoutModel: {
      type: String,
      enum: ['COMMISSION', 'CLASS_RATE'],
      default: 'COMMISSION',
    },
    // Agreed teacher commission % (e.g. 50%)
    commissionPercent: {
      type: Number,
      required: true,
      default: 50,
    },
    // Final calculated compensation for this session
    calculatedAmount: {
      type: Number,
      required: true,
      default: 50,
    },
    // Human-readable transparent calculation audit string (e.g. "(₹800 ÷ 8) × 50% = ₹50")
    calculationFormula: {
      type: String,
      default: '',
    },
    // Session Class Date
    classDate: {
      type: Date,
      index: true,
    },
    // Payout Lifecycle Status
    status: {
      type: String,
      enum: ['PENDING', 'VALIDATED', 'PROCESSED', 'REVERSED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },
    // Disbursement batch ID when processed (e.g. PAYOUT-202611-001)
    payoutBatchId: {
      type: String,
      default: null,
      index: true,
    },
    // Payment disbursement details
    paymentMethod: {
      type: String,
      enum: ['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', null],
      default: null,
    },
    paymentReference: {
      type: String,
      default: null,
      trim: true,
    },
    validatedAt: {
      type: Date,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for rapid analytics & filtering
TeacherLedgerSchema.index({ teacherId: 1, status: 1 });
TeacherLedgerSchema.index({ groupId: 1, classDate: -1 });
TeacherLedgerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TeacherLedger', TeacherLedgerSchema);
