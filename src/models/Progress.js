const mongoose = require('mongoose');

const ProgressSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
    },
    currentLevel: {
      type: String,
      default: 'Beginner',
    },
    overallPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    milestones: [
      {
        title: { type: String, required: true },
        description: { type: String },
        completed: { type: Boolean, default: false },
        completedAt: { type: Date },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Progress', ProgressSchema);
