const path = require('path');
const fs = require('fs');
const Teacher = require('../models/Teacher');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

const SEED_TEACHERS = [
  {
    name: 'Pt. Rajendra Sharma',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    phoneNumber: '+91 98290 12345',
    alternativePhoneNumber: '+91 98290 12346',
    email: 'rajendra.sharma@academy.com',
    alternativeEmail: 'pt.rajendra@gmail.com',
    instruments: ['Harmonium', 'Classical Vocal', 'Light Music / Singing'],
    qualification: 'Sangeet Visharad (Gandharva Mahavidyalaya)',
    experienceYears: 15,
    city: 'Jaipur',
    state: 'Rajasthan',
    hourlyOrClassRate: 700,
    commissionPercentage: 60,
    status: 'Active',
    isActive: true,
    bio: 'Senior Classical Vocal and Harmonium Guru with over 15 years of stage performance and teaching experience.',
    notes: 'Available for morning and evening batches.',
  },
  {
    name: 'Ustad Tariq Hussain',
    avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    phoneNumber: '+91 98110 54321',
    alternativePhoneNumber: '',
    email: 'tariq.hussain@academy.com',
    alternativeEmail: 'tariq.tabla@gmail.com',
    instruments: ['Tabla'],
    qualification: 'Master of Performing Arts (Tabla)',
    experienceYears: 12,
    city: 'Delhi',
    state: 'Delhi',
    hourlyOrClassRate: 650,
    commissionPercentage: 55,
    status: 'Active',
    isActive: true,
    bio: 'Renowned Tabla exponent specializing in Delhi and Punjab gharana compositions, teentaal and accompaniment.',
    notes: 'Available on weekdays.',
  },
  {
    name: 'Dr. Sunita Rao',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    phoneNumber: '+91 97400 98765',
    alternativePhoneNumber: '',
    email: 'sunita.rao@academy.com',
    alternativeEmail: 'dr.sunita@gmail.com',
    instruments: ['Keyboard / Piano', 'Guitar'],
    qualification: 'Trinity College Grade 8 Certified',
    experienceYears: 9,
    city: 'Bengaluru',
    state: 'Karnataka',
    hourlyOrClassRate: 600,
    commissionPercentage: 50,
    status: 'Active',
    isActive: true,
    bio: 'Certified Piano and Western Vocal faculty mentoring beginner to advanced diploma students.',
    notes: 'Handles weekend batches.',
  },
];

// List Teachers with search, status filter, and pagination
const listTeachers = async (req, res, next) => {
  try {
    const { search, status, instrument, activeOnly, page = 1, limit = 100 } = req.query;

    // Auto-seed if empty
    const count = await Teacher.countDocuments();
    if (count === 0) {
      await Teacher.insertMany(SEED_TEACHERS);
    }

    const filter = {};

    if (activeOnly === 'true') {
      filter.status = 'Active';
    } else if (status && status !== 'ALL') {
      filter.status = status;
    }

    if (instrument && instrument !== 'ALL') {
      filter.instruments = instrument;
    }

    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q, 'i');
      filter.$or = [
        { name: regex },
        { email: regex },
        { alternativeEmail: regex },
        { phoneNumber: regex },
        { alternativePhoneNumber: regex },
        { instruments: regex },
        { qualification: regex },
        { city: regex },
        { state: regex },
      ];
    }

    const [teachers, total] = await Promise.all([
      Teacher.find(filter).sort({ createdAt: -1 }).limit(Number(limit)),
      Teacher.countDocuments(filter),
    ]);

    return successResponse(res, {
      teachers,
      total,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// Get single teacher by ID
const getTeacherById = async (req, res, next) => {
  try {
    const teacher = await Teacher.findById(req.params.id);
    if (!teacher) {
      return errorResponse(res, 'Teacher not found.', statusCodes.NOT_FOUND);
    }
    return successResponse(res, { teacher });
  } catch (err) {
    next(err);
  }
};

// Create new Teacher with details and picture
const createTeacher = async (req, res, next) => {
  try {
    const {
      name,
      avatarUrl,
      phoneNumber,
      alternativePhoneNumber,
      email,
      alternativeEmail,
      instruments,
      experienceYears,
      qualification,
      bio,
      city,
      state,
      hourlyOrClassRate,
      commissionPercentage,
      status = 'Active',
      assignedBatches,
      notes,
    } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 'Teacher Full Name is required.', statusCodes.BAD_REQUEST);
    }

    const parsedInstruments = Array.isArray(instruments)
      ? instruments
      : instruments
      ? instruments.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const parsedBatches = Array.isArray(assignedBatches)
      ? assignedBatches
      : assignedBatches
      ? assignedBatches.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const isTeacherActive = status === 'Active';

    const teacher = await Teacher.create({
      name: name.trim(),
      avatarUrl: avatarUrl ? avatarUrl.trim() : '',
      phoneNumber: phoneNumber && phoneNumber.trim() ? phoneNumber.trim() : undefined,
      alternativePhoneNumber: alternativePhoneNumber && alternativePhoneNumber.trim() ? alternativePhoneNumber.trim() : null,
      email: email && email.trim() ? email.toLowerCase().trim() : undefined,
      alternativeEmail: alternativeEmail ? alternativeEmail.toLowerCase().trim() : '',
      instruments: parsedInstruments,
      experienceYears: Number(experienceYears) || 0,
      qualification: qualification ? qualification.trim() : '',
      bio: bio ? bio.trim() : '',
      city: city ? city.trim() : '',
      state: state ? state.trim() : '',
      hourlyOrClassRate: Number(hourlyOrClassRate) || 500,
      commissionPercentage: Number(commissionPercentage) || 50,
      status: status === 'Left' ? 'Left' : status === 'Inactive' ? 'Inactive' : 'Active',
      isActive: isTeacherActive,
      assignedBatches: parsedBatches,
      notes: notes ? notes.trim() : '',
    });

    return successResponse(res, { teacher }, 'Teacher created successfully.', statusCodes.CREATED);
  } catch (err) {
    next(err);
  }
};

// Update Teacher
const updateTeacher = async (req, res, next) => {
  try {
    const updateData = { ...req.body };

    if (updateData.name) {
      updateData.name = updateData.name.trim();
    }

    if (typeof updateData.instruments === 'string') {
      updateData.instruments = updateData.instruments.split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (typeof updateData.assignedBatches === 'string') {
      updateData.assignedBatches = updateData.assignedBatches.split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (updateData.experienceYears !== undefined) {
      updateData.experienceYears = Number(updateData.experienceYears) || 0;
    }

    if (updateData.hourlyOrClassRate !== undefined) {
      updateData.hourlyOrClassRate = Number(updateData.hourlyOrClassRate) || 500;
    }

    if (updateData.commissionPercentage !== undefined) {
      updateData.commissionPercentage = Number(updateData.commissionPercentage) || 50;
    }

    if (updateData.phoneNumber !== undefined) {
      if (!updateData.phoneNumber || !updateData.phoneNumber.trim()) {
        delete updateData.phoneNumber;
      } else {
        updateData.phoneNumber = updateData.phoneNumber.trim();
      }
    }

    if (updateData.email !== undefined) {
      if (!updateData.email || !updateData.email.trim()) {
        delete updateData.email;
      } else {
        updateData.email = updateData.email.toLowerCase().trim();
      }
    }

    if (updateData.alternativeEmail !== undefined) {
      updateData.alternativeEmail = updateData.alternativeEmail ? updateData.alternativeEmail.toLowerCase().trim() : '';
    }

    if (updateData.alternativePhoneNumber !== undefined) {
      updateData.alternativePhoneNumber = updateData.alternativePhoneNumber ? updateData.alternativePhoneNumber.trim() : null;
    }

    if (updateData.status !== undefined) {
      updateData.status = updateData.status === 'Left' ? 'Left' : updateData.status === 'Inactive' ? 'Inactive' : 'Active';
      updateData.isActive = updateData.status === 'Active';
    } else if (updateData.isActive !== undefined) {
      updateData.status = updateData.isActive ? 'Active' : 'Left';
    }

    const updated = await Teacher.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return errorResponse(res, 'Teacher not found.', statusCodes.NOT_FOUND);
    }

    return successResponse(res, { teacher: updated }, 'Teacher updated successfully.');
  } catch (err) {
    next(err);
  }
};

// Delete Teacher
const deleteTeacher = async (req, res, next) => {
  try {
    const deleted = await Teacher.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return errorResponse(res, 'Teacher not found.', statusCodes.NOT_FOUND);
    }
    return successResponse(res, null, 'Teacher deleted successfully.');
  } catch (err) {
    next(err);
  }
};

// Upload teacher avatar / profile picture
const uploadTeacherAvatar = async (req, res, next) => {
  try {
    const { fileData, fileName = `teacher_${Date.now()}.jpg`, fileType = 'image/jpeg' } = req.body;
    if (!fileData) {
      return errorResponse(res, 'No image file data provided.', statusCodes.BAD_REQUEST);
    }

    const cleanBase64 = fileData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const uploadsDir = path.join(__dirname, '../../uploads');
    const imagesDir = path.join(uploadsDir, 'images');

    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const filePath = path.join(imagesDir, safeName);
    fs.writeFileSync(filePath, buffer);

    const host = process.env.SERVER_HOST || req.get('host') || 'localhost:5000';
    const protocol = req.protocol || 'http';
    const fileUrl = `${protocol}://${host}/uploads/images/${safeName}`;

    // If teacher ID is specified in params, automatically update that teacher's profile
    if (req.params.id) {
      const teacher = await Teacher.findByIdAndUpdate(
        req.params.id,
        { avatarUrl: fileUrl },
        { new: true }
      );
      if (!teacher) {
        return errorResponse(res, 'Teacher not found.', statusCodes.NOT_FOUND);
      }
      return successResponse(
        res,
        { url: fileUrl, teacher },
        'Teacher avatar uploaded and profile updated successfully.',
        statusCodes.OK
      );
    }

    return successResponse(
      res,
      {
        url: fileUrl,
        category: 'images',
        fileName: safeName,
        fileSize: `${(buffer.length / 1024).toFixed(1)} KB`,
        fileType,
      },
      'Teacher profile photo uploaded successfully.',
      statusCodes.CREATED
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listTeachers,
  getTeacherById,
  createTeacher,
  updateTeacher,
  deleteTeacher,
  uploadTeacherAvatar,
};
