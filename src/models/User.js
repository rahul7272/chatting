const mongoose = require('mongoose');
const { ALL_ROLES, ROLES } = require('../constants/roles');

const UserSchema = new mongoose.Schema(
  {
    // पूरा नाम (Name)
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // मोबाइल नंबर (Mobile Number)
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
    // ईमेल (Email)
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    // (DOB)
    dob: {
      type: String, // String or Date for flexible formatting like DD/MM/YYYY or YYYY-MM-DD
      default: null,
      trim: true,
    },
    // उम्र (Age)
    age: {
      type: Number,
      default: null,
    },
    // शहर (City)
    city: {
      type: String,
      default: '',
      trim: true,
    },
    // राज्य (State)
    state: {
      type: String,
      default: '',
      trim: true,
    },
    // Instrument Name / Course Name (Multiple batches / instruments enrolled)
    // e.g. ["Harmonium", "Keyboard", "Vocal", "Tabla", "Guitar", "Flute"]
    instruments: {
      type: [String],
      default: [],
    },
    // Student Level - Beginner, Intermediate, Advance, etc.
    studentLevel: {
      type: String,
      enum: ['Beginner', 'Intermediate', 'Advance', 'Master'],
      default: 'Beginner',
    },
    // Admission / Enrollment Date
    admissionDate: {
      type: Date,
      default: Date.now,
    },
    // Guardian / Parent Name (if student is minor)
    guardianName: {
      type: String,
      default: '',
      trim: true,
    },
    // Full Address
    address: {
      type: String,
      default: '',
      trim: true,
    },
    // Role (STUDENT, TEACHER, MANAGER, ADMIN)
    role: {
      type: String,
      enum: ALL_ROLES,
      default: ROLES.STUDENT,
      required: true,
      index: true,
    },
    avatarUrl: {
      type: String,
      default: null,
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
    // Live Class Credit Balance
    enrolledCreditBalance: {
      type: Number,
      default: 0,
    },
    // Relevant for teachers
    hourlyOrClassRate: {
      type: Number,
      default: 0,
    },
    commissionPercentage: {
      type: Number,
      default: 50,
    },
    // Admin Notes
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Virtual for formatted instruments string
UserSchema.virtual('coursesList').get(function () {
  return (this.instruments || []).join(', ');
});

module.exports = mongoose.model('User', UserSchema);
