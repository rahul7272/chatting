const mongoose = require('mongoose');

const TeacherHistorySchema = new mongoose.Schema(
  {
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    teacherName: { type: String, default: '' },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: { type: String, default: 'Admin' },
    removedAt: { type: Date, default: null },
    reason: { type: String, default: '' },
  },
  { _id: true }
);

const ViewerLogSchema = new mongoose.Schema(
  {
    userId: { type: String, default: '' },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    userName: { type: String, default: 'Student' },
    userEmail: { type: String, default: '' },
    userRole: { type: String, default: 'STUDENT' },
    avatarUrl: { type: String, default: '' },
    watchedAt: { type: Date, default: Date.now },
    watchCount: { type: Number, default: 1 },
  },
  { _id: true }
);

const RecordingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    topic: { type: String, default: '' },
    url: { type: String, required: true },
    date: { type: String, default: () => new Date().toISOString().split('T')[0] },
    durationMinutes: { type: Number, default: 60 },
    addedBy: { type: String, default: 'Instructor / Admin' },
    createdAt: { type: Date, default: Date.now },
    viewers: [ViewerLogSchema],
  },
  { _id: true }
);

const ResourceSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    type: {
      type: String,
      enum: ['note', 'assignment', 'pdf', 'document', 'audio', 'link'],
      default: 'note',
    },
    fileUrl: { type: String, default: '' },
    description: { type: String, default: '' },
    dueDate: { type: String, default: '' },
    isPublished: { type: Boolean, default: true },
    addedBy: { type: String, default: 'Instructor / Admin' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ActivityLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    actorName: { type: String, default: 'Admin' },
    details: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true }
);

const AnnouncementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    message: { type: String, required: true },
    target: {
      type: String,
      enum: ['ALL', 'STUDENTS_ONLY', 'TEACHER_ONLY'],
      default: 'ALL',
    },
    sentAt: { type: Date, default: Date.now },
    sentBy: { type: String, default: 'Admin' },
  },
  { _id: true }
);

const GroupSchema = new mongoose.Schema(
  {
    // Group / Batch Name
    title: {
      type: String,
      required: true,
      trim: true,
    },
    // Batch Code (e.g. VOC-BEG-A)
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    // Group Profile Picture / Avatar URL
    avatar: {
      type: String,
      default: '',
      trim: true,
    },
    profilePic: {
      type: String,
      default: '',
      trim: true,
    },
    // Course / Subject Name (e.g. Vocal, Piano, Guitar)
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    // Skill Level
    level: {
      type: String,
      enum: ['Beginner', 'Intermediate', 'Advanced', 'Master', 'All Levels'],
      default: 'Beginner',
    },
    // Lifecycle Status
    status: {
      type: String,
      enum: ['Draft', 'Active', 'Paused', 'Inactive', 'Archived'],
      default: 'Active',
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Assigned Primary Faculty / Teacher
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      required: false,
      index: true,
    },
    teacherName: {
      type: String,
      default: '',
    },
    // Historical Teacher Reassignment Logs
    teacherHistory: [TeacherHistorySchema],
    // Enrolled Students
    studentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
      },
    ],
    // Persistent Google Meet Link
    meetUrl: {
      type: String,
      default: 'https://meet.google.com/new',
      trim: true,
    },
    // Class Schedule Configuration
    schedule: {
      daysOfWeek: [{ type: Number }], // 0: Sun, 1: Mon, 2: Tue, 3: Wed, 4: Thu, 5: Fri, 6: Sat
      dayNames: [{ type: String }], // e.g. ['Monday', 'Friday']
      startTime: { type: String, default: '05:00 PM' },
      endTime: { type: String, default: '06:00 PM' },
      timezone: { type: String, default: 'Asia/Kolkata' },
      notes: { type: String, default: '' },
    },
    // Group Communication & Feature Permissions
    chatSettings: {
      chatEnabled: { type: Boolean, default: true },
      pollsEnabled: { type: Boolean, default: true },
      mentionsEnabled: { type: Boolean, default: true },
      everyoneEnabled: { type: Boolean, default: true },
      personalChatAllowed: { type: Boolean, default: false },
      historyPolicy: {
        type: String,
        enum: ['FULL', '30_DAYS', '7_DAYS', 'FROM_JOIN', 'NONE'],
        default: 'FULL',
      },
      allowRecordings: { type: Boolean, default: true },
      allowNotes: { type: Boolean, default: true },
      allowAssignments: { type: Boolean, default: true },
      showMembers: { type: Boolean, default: true },
      showMemberCount: { type: Boolean, default: true },
    },
    // Class Recordings
    recordings: [RecordingSchema],
    // Notes & Assignments
    resources: [ResourceSchema],
    // Group Announcements & Notifications
    announcements: [AnnouncementSchema],
    // Immutable Audit / Activity Timeline
    activityLogs: [ActivityLogSchema],
    createdBy: {
      type: String,
      default: 'Admin Console',
    },
  },
  {
    timestamps: true,
  }
);

// Ensure status and isActive stay synchronized
GroupSchema.pre('save', function (next) {
  if (this.status === 'Inactive' || this.status === 'Archived') {
    this.isActive = false;
  } else if (this.status === 'Active') {
    this.isActive = true;
  }
  next();
});

module.exports = mongoose.model('Group', GroupSchema);

