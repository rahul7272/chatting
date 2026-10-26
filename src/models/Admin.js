const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema(
  {
    // Full Name
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Email Address
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },
    // Mobile Number
    phoneNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    role: {
      type: String,
      enum: ['ADMIN', 'MANAGER'],
      default: 'ADMIN',
      required: true,
    },
    department: {
      type: String,
      default: 'Operations & Management',
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    fcmTokens: [
      {
        type: String,
      },
    ],
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
    collection: 'admins', // Saved in dedicated 'admins' collection in MongoDB
  }
);

module.exports = mongoose.model('Admin', AdminSchema);
