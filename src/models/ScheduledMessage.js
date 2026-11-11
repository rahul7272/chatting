const mongoose = require('mongoose');

const ScheduledMessageSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },
    senderName: {
      type: String,
      default: '',
      trim: true,
    },
    senderAvatar: {
      type: String,
      default: '',
    },
    senderRole: {
      type: String,
      default: 'STUDENT',
    },
    text: {
      type: String,
      default: '',
      trim: true,
    },
    type: {
      type: String,
      enum: ['TEXT', 'IMAGE', 'FILE', 'DOCUMENT', 'VOICE', 'AUDIO', 'LOCATION', 'POLL'],
      default: 'TEXT',
    },
    attachments: [
      {
        url: { type: String },
        fileType: { type: String },
        fileName: { type: String },
        fileSize: { type: mongoose.Schema.Types.Mixed },
      },
    ],
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    pollData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    mentions: [
      {
        userId: { type: String },
        name: { type: String, default: '' },
      },
    ],
    scheduledFor: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'SENT', 'FAILED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    dispatchedMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    error: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

ScheduledMessageSchema.index({ status: 1, scheduledFor: 1 });
ScheduledMessageSchema.index({ groupId: 1, status: 1 });

module.exports = mongoose.model('ScheduledMessage', ScheduledMessageSchema);

