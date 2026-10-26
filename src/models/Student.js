const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema(
  {
    // Full Name
    name: {
      type: String,
      required: true,
      trim: true,
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
    // Alternative Email / Gmail Address
    alternativeEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
    },
    // Date of Birth (YYYY-MM-DD)
    dob: {
      type: String,
      default: null,
      trim: true,
    },
    // Age in years (Auto-calculated)
    age: {
      type: Number,
      default: null,
    },
    // City
    city: {
      type: String,
      default: '',
      trim: true,
    },
    // State
    state: {
      type: String,
      default: '',
      trim: true,
    },
    // Status: Active / Left
    status: {
      type: String,
      enum: ['Active', 'Left'],
      default: 'Active',
      index: true,
    },
    // Assigned Teacher Name (String summary)
    teacherName: {
      type: String,
      default: '',
      trim: true,
    },
    // Assigned Teachers (Multiple teachers supported)
    teachers: {
      type: [String],
      default: [],
    },
    // Course / Admission Fee
    fee: {
      type: Number,
      default: 0,
    },
    // Batch Name / Cohort
    batchName: {
      type: String,
      default: '',
      trim: true,
    },
    // GST Applicable: YES / NO
    gst: {
      type: String,
      enum: ['YES', 'NO'],
      default: 'NO',
    },
    // Enrollment Number / Admission ID
    enrollmentNo: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    // Enrolled Instrument Name / Course Name (Multiple courses supported)
    instruments: {
      type: [String],
      default: [],
    },
    // Student Level
    studentLevel: {
      type: String,
      enum: ['Beginner', 'Intermediate', 'Advance', 'Master'],
      default: 'Beginner',
    },
    // Class Credit Balance
    enrolledCreditBalance: {
      type: Number,
      default: 0,
    },
    // Parent / Guardian Name
    guardianName: {
      type: String,
      default: '',
      trim: true,
    },
    // Residential Address
    address: {
      type: String,
      default: '',
      trim: true,
    },
    role: {
      type: String,
      default: 'STUDENT',
      immutable: true,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    avatar: {
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
    admissionDate: {
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
    collection: 'students', // Saved in dedicated 'students' collection in MongoDB
  }
);

module.exports = mongoose.model('Student', StudentSchema);
