const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['ANNOUNCEMENT', 'BATCH_NOTICE', 'CLASS_REMINDER_15M', 'CLASS_ALERT_5M', 'SYSTEM', 'MESSAGE'],
      default: 'ANNOUNCEMENT',
    },
    priority: {
      type: String,
      enum: ['STANDARD', 'HIGH', 'URGENT'],
      default: 'STANDARD',
    },
    targetAudience: {
      type: String,
      enum: ['ALL', 'STUDENTS', 'TEACHERS', 'BATCH_GROUPS', 'INDIVIDUAL'],
      default: 'ALL',
    },
    targetGroupIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
      },
    ],
    targetGroupTitles: [
      {
        type: String,
      },
    ],
    targetRoles: [
      {
        type: String,
        default: 'ALL',
      },
    ],
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      default: null,
    },
    classTitle: {
      type: String,
      default: '',
    },
    meetUrl: {
      type: String,
      default: '',
    },
    actionUrl: {
      type: String,
      default: '',
    },
    sentBy: {
      type: String,
      default: 'Academy Administrator',
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    readBy: [
      {
        type: String,
      },
    ],
    recipientsCount: {
      type: Number,
      default: 0,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

NotificationSchema.index({ sentAt: -1 });
NotificationSchema.index({ targetAudience: 1, sentAt: -1 });
NotificationSchema.index({ targetGroupIds: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
