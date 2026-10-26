const mongoose = require('mongoose');

const RenewalTaskSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    currentBalance: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'CONTACTED', 'RENEWED', 'DISCONTINUED'],
      default: 'PENDING',
      index: true,
    },
    assignedManagerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastFollowUpAt: {
      type: Date,
      default: null,
    },
    notes: [
      {
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('RenewalTask', RenewalTaskSchema);
