const mongoose = require('mongoose');

const TeacherSchema = new mongoose.Schema(
  {
    // Full Name
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Profile Picture / Avatar URL
    avatarUrl: {
      type: String,
      default: '',
    },
    // Mobile Number
    phoneNumber: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true,
    },
    // Alternative Mobile Number
    alternativePhoneNumber: {
      type: String,
      default: null,
      trim: true,
    },
    // Email Address
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    // Alternative Email Address
    alternativeEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
    },
    // Specialization / Instruments Taught (Multiple)
    instruments: {
      type: [String],
      default: [],
    },
    experienceYears: {
      type: Number,
      default: 0,
    },
    qualification: {
      type: String,
      default: '',
      trim: true,
    },
    bio: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      default: '',
      trim: true,
    },
    state: {
      type: String,
      default: '',
      trim: true,
    },
    // Payout Model Type: Commission Percentage vs Fixed Class Rate
    payoutType: {
      type: String,
      enum: ['COMMISSION', 'CLASS_RATE'],
      default: 'COMMISSION',
    },
    // Class Payout Rate (₹ per class/hour) - applicable ONLY when payoutType === 'CLASS_RATE'
    hourlyOrClassRate: {
      type: Number,
      default: 0,
    },
    // Commission Percentage - applicable ONLY when payoutType === 'COMMISSION'
    commissionPercentage: {
      type: Number,
      default: 50,
    },
    // Status: Active / Left / Inactive
    status: {
      type: String,
      enum: ['Active', 'Left', 'Inactive'],
      default: 'Active',
      index: true,
    },
    role: {
      type: String,
      default: 'TEACHER',
      immutable: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    assignedBatches: {
      type: [String],
      default: [],
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
    joiningDate: {
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
    collection: 'teachers', // Saved in dedicated 'teachers' collection in MongoDB
  }
);

// Pre-save hook to keep isActive in sync with status
TeacherSchema.pre('save', function (next) {
  if (this.status) {
    this.isActive = this.status === 'Active';
  }
  next();
});

module.exports = mongoose.model('Teacher', TeacherSchema);
