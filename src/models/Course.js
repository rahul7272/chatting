const mongoose = require('mongoose');

const CourseSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Course name is required'],
      unique: true,
      trim: true,
      index: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
    },
    category: {
      type: String,
      enum: ['Instrument', 'Vocal', 'Theory', 'Dance', 'Other'],
      default: 'Instrument',
    },
    icon: {
      type: String,
      default: '🎵',
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: 'courses',
  }
);

module.exports = mongoose.model('Course', CourseSchema);
