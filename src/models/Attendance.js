const mongoose = require('mongoose');
require('./Student');
require('./Teacher');
require('./Group');
require('./User');

const AttendanceSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Group',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Student',
      required: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Teacher',
      required: false,
    },
    classDate: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['PRESENT', 'ABSENT', 'EXCUSED'],
      required: true,
    },
    creditDeducted: {
      type: Boolean,
      default: false,
    },
    payoutCalculated: {
      type: Boolean,
      default: false,
    },
    markedBy: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
    },
    remarks: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

AttendanceSchema.index({ groupId: 1, studentId: 1, classDate: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', AttendanceSchema);
