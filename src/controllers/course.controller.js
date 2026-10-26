const Course = require('../models/Course');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

const DEFAULT_COURSES = [
  { name: 'Harmonium', category: 'Instrument', icon: '🎹', code: 'HARM-01' },
  { name: 'Keyboard / Piano', category: 'Instrument', icon: '🎹', code: 'KEYB-01' },
  { name: 'Classical Vocal', category: 'Vocal', icon: '🎤', code: 'VOC-01' },
  { name: 'Light Music / Singing', category: 'Vocal', icon: '🎶', code: 'VOC-02' },
  { name: 'Tabla', category: 'Instrument', icon: '🪘', code: 'TABL-01' },
  { name: 'Guitar', category: 'Instrument', icon: '🎸', code: 'GUIT-01' },
  { name: 'Flute', category: 'Instrument', icon: '🎵', code: 'FLUT-01' },
  { name: 'Violin', category: 'Instrument', icon: '🎻', code: 'VIOL-01' },
  { name: 'Sitar', category: 'Instrument', icon: '🪕', code: 'SITR-01' },
];

// List all courses (auto-seed if empty)
const listCourses = async (req, res, next) => {
  try {
    const { activeOnly, search } = req.query;
    const filter = {};

    if (activeOnly === 'true') {
      filter.isActive = true;
    }

    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q, 'i');
      filter.$or = [{ name: regex }, { code: regex }, { category: regex }];
    }

    let count = await Course.countDocuments();
    if (count === 0) {
      // Auto seed default courses
      await Course.insertMany(DEFAULT_COURSES);
    }

    const courses = await Course.find(filter).sort({ sortOrder: 1, name: 1 });

    return successResponse(res, {
      courses,
      total: courses.length,
    });
  } catch (err) {
    next(err);
  }
};

// Create a new course
const createCourse = async (req, res, next) => {
  try {
    const { name, code, category = 'Instrument', icon = '🎵', description = '', isActive = true } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 'Course name is required.', statusCodes.BAD_REQUEST);
    }

    const trimmedName = name.trim();

    // Check case-insensitive duplicate
    const existing = await Course.findOne({
      name: { $regex: new RegExp(`^${trimmedName}$`, 'i') },
    });

    if (existing) {
      return errorResponse(res, `A course named '${trimmedName}' already exists.`, statusCodes.CONFLICT);
    }

    const newCourse = await Course.create({
      name: trimmedName,
      code: code ? code.trim().toUpperCase() : trimmedName.substring(0, 4).toUpperCase() + '-01',
      category,
      icon: icon || '🎵',
      description: description ? description.trim() : '',
      isActive: isActive !== undefined ? Boolean(isActive) : true,
    });

    return successResponse(
      res,
      { course: newCourse },
      'Course created successfully.',
      statusCodes.CREATED
    );
  } catch (err) {
    next(err);
  }
};

// Update an existing course
const updateCourse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, code, category, icon, description, isActive, sortOrder } = req.body;

    const course = await Course.findById(id);
    if (!course) {
      return errorResponse(res, 'Course not found.', statusCodes.NOT_FOUND);
    }

    if (name && name.trim()) {
      const trimmedName = name.trim();
      const existing = await Course.findOne({
        _id: { $ne: id },
        name: { $regex: new RegExp(`^${trimmedName}$`, 'i') },
      });
      if (existing) {
        return errorResponse(res, `Another course named '${trimmedName}' already exists.`, statusCodes.CONFLICT);
      }
      course.name = trimmedName;
    }

    if (code !== undefined) course.code = code.trim().toUpperCase();
    if (category !== undefined) course.category = category;
    if (icon !== undefined) course.icon = icon;
    if (description !== undefined) course.description = description.trim();
    if (isActive !== undefined) course.isActive = Boolean(isActive);
    if (sortOrder !== undefined) course.sortOrder = Number(sortOrder);

    await course.save();

    return successResponse(res, { course }, 'Course updated successfully.');
  } catch (err) {
    next(err);
  }
};

// Delete a course
const deleteCourse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const course = await Course.findById(id);
    if (!course) {
      return errorResponse(res, 'Course not found.', statusCodes.NOT_FOUND);
    }

    await Course.findByIdAndDelete(id);

    return successResponse(res, null, 'Course deleted successfully.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listCourses,
  createCourse,
  updateCourse,
  deleteCourse,
};
