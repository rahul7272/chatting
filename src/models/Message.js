const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
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
    text: {
      type: String,
      default: '',
      trim: true,
    },
    type: {
      type: String,
      enum: ['TEXT', 'IMAGE', 'VIDEO', 'FILE', 'DOCUMENT', 'VOICE', 'AUDIO', 'LOCATION', 'POLL', 'SYSTEM'],
      default: 'TEXT',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    attachments: [
      {
        url: { type: String, required: false },
        fileType: { type: String },
        fileName: { type: String },
        fileSize: { type: mongoose.Schema.Types.Mixed },
      },
    ],
    pollData: {
      question: { type: String },
      isMultipleChoice: { type: Boolean, default: false },
      allowAnonymous: { type: Boolean, default: false },
      options: [
        {
          id: { type: String },
          text: { type: String },
          title: { type: String },
          votes: [{ type: mongoose.Schema.Types.Mixed }],
          voters: [{ type: mongoose.Schema.Types.Mixed }],
        },
      ],
      closed: { type: Boolean, default: false },
    },
    readBy: [
      {
        type: mongoose.Schema.Types.Mixed,
      },
    ],
    seenBy: [
      {
        userId: { type: String },
        name: { type: String, default: '' },
        avatarUrl: { type: String, default: '' },
        role: { type: String, default: 'STUDENT' },
        seenAt: { type: Date, default: Date.now },
      },
    ],
    replyTo: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    reactions: [
      {
        userId: { type: String },
        emoji: { type: String },
        userName: { type: String },
      },
    ],
    mentions: [
      {
        userId: { type: String },
        name: { type: String, default: '' },
      },
    ],
    mentionedNames: [
      {
        type: String,
      },
    ],
    isPinned: {
      type: Boolean,
      default: false,
      index: true,
    },
    pinnedAt: {
      type: Date,
      default: null,
    },
    pinnedBy: {
      type: String,
      default: '',
    },
    isForwarded: {
      type: Boolean,
      default: false,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedFor: [
      {
        type: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

MessageSchema.index({ groupId: 1, createdAt: -1 });
MessageSchema.index({ groupId: 1, isPinned: 1 });
MessageSchema.index({ groupId: 1, type: 1 });
MessageSchema.index({ text: 'text' });

module.exports = mongoose.model('Message', MessageSchema);
