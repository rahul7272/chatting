const mongoose = require('mongoose');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Admin = require('../models/Admin');
const { findAccountById } = require('../utils/userLocator');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const { ROLES } = require('../constants/roles');

// List users from their respective collections (students, teachers, admins)
const listUsers = async (req, res, next) => {
  try {
    const { role, search, level, studentLevel, page = 1, limit = 50 } = req.query;
    const filter = {};

    const lvl = level || studentLevel;
    if (lvl && lvl !== 'ALL') {
      filter.studentLevel = lvl;
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
        { city: regex },
        { state: regex },
        { instruments: regex },
        { teacherName: regex },
        { batchName: regex },
        { enrollmentNo: regex },
      ];
    }

    let users = [];
    let total = 0;

    const targetRole = (role || 'STUDENT').toUpperCase();

    if (targetRole === 'STUDENT') {
      [users, total] = await Promise.all([
        Student.find(filter).sort({ createdAt: -1 }).limit(Number(limit)),
        Student.countDocuments(filter),
      ]);
    } else if (targetRole === 'TEACHER') {
      [users, total] = await Promise.all([
        Teacher.find(filter).sort({ createdAt: -1 }).limit(Number(limit)),
        Teacher.countDocuments(filter),
      ]);
    } else if (targetRole === 'ADMIN' || targetRole === 'MANAGER') {
      const adminFilter = { ...filter, role: targetRole };
      [users, total] = await Promise.all([
        Admin.find(adminFilter).sort({ createdAt: -1 }).limit(Number(limit)),
        Admin.countDocuments(adminFilter),
      ]);
    } else {
      // ALL: Query all 3 collections and combine
      const [students, teachers, admins] = await Promise.all([
        Student.find(filter).sort({ createdAt: -1 }).limit(Number(limit)),
        Teacher.find(filter).sort({ createdAt: -1 }).limit(Number(limit)),
        Admin.find(filter).sort({ createdAt: -1 }).limit(Number(limit)),
      ]);

      const [countS, countT, countA] = await Promise.all([
        Student.countDocuments(filter),
        Teacher.countDocuments(filter),
        Admin.countDocuments(filter),
      ]);

      users = [...admins, ...teachers, ...students].sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      total = countS + countT + countA;
    }

    return successResponse(res, {
      users,
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

// Get single user by ID across collections
const getUserById = async (req, res, next) => {
  try {
    const accountInfo = await findAccountById(req.params.id);
    if (!accountInfo) {
      return errorResponse(res, 'Account not found.', statusCodes.NOT_FOUND);
    }
    return successResponse(res, { user: accountInfo.account, role: accountInfo.type });
  } catch (err) {
    next(err);
  }
};

// Create new record in appropriate collection (students, teachers, admins)
const createUser = async (req, res, next) => {
  try {
    const {
      name,
      phoneNumber,
      alternativePhoneNumber,
      email,
      dob,
      age,
      city,
      state,
      instruments,
      studentLevel,
      role = 'STUDENT',
      enrolledCreditBalance = 0,
      hourlyOrClassRate = 500,
      commissionPercentage = 50,
      qualification,
      experienceYears,
      guardianName,
      address,
      notes,
    } = req.body;

    if (!name) {
      return errorResponse(res, 'Full Name is required.', statusCodes.BAD_REQUEST);
    }

    const assignedRole = (role || 'STUDENT').toUpperCase();
    let newUser;

    const parsedInstruments = Array.isArray(instruments)
      ? instruments
      : instruments
      ? instruments.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    if (assignedRole === 'TEACHER') {
      // Save in 'teachers' collection
      newUser = await Teacher.create({
        name: name.trim(),
        phoneNumber: phoneNumber ? phoneNumber.trim() : undefined,
        alternativePhoneNumber: alternativePhoneNumber ? alternativePhoneNumber.trim() : null,
        email: email ? email.toLowerCase().trim() : undefined,
        city: city ? city.trim() : '',
        state: state ? state.trim() : '',
        instruments: parsedInstruments,
        qualification: qualification ? qualification.trim() : '',
        experienceYears: Number(experienceYears) || 0,
        hourlyOrClassRate: Number(hourlyOrClassRate) || 500,
        commissionPercentage: Number(commissionPercentage) || 50,
        role: 'TEACHER',
        notes: notes ? notes.trim() : '',
      });
    } else if (assignedRole === 'ADMIN' || assignedRole === 'MANAGER') {
      // Save in 'admins' collection
      newUser = await Admin.create({
        name: name.trim(),
        email: email ? email.toLowerCase().trim() : `${name.toLowerCase().replace(/\s+/g, '')}@academy.com`,
        phoneNumber: phoneNumber ? phoneNumber.trim() : undefined,
        role: assignedRole,
        department: 'Operations',
        notes: notes ? notes.trim() : '',
      });
    } else {
      // Default: Save in 'students' collection
      const {
        alternativeEmail,
        status = 'Active',
        teacherName,
        teachers = [],
        fee = 0,
        batchName,
        gst = 'NO',
        enrollmentNo,
      } = req.body;

      const isStudentActive = status === 'Active';
      const cleanEnrollmentNo = enrollmentNo && enrollmentNo.trim()
        ? enrollmentNo.trim().toUpperCase()
        : `ENR-${Date.now().toString().slice(-6)}`;

      let calculatedAge = age !== undefined && age !== null && age !== '' ? Number(age) : null;
      if (!calculatedAge && dob) {
        const birthDate = new Date(dob);
        if (!isNaN(birthDate.getTime())) {
          const today = new Date();
          let a = today.getFullYear() - birthDate.getFullYear();
          const m = today.getMonth() - birthDate.getMonth();
          if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) a--;
          if (a >= 0 && a < 120) calculatedAge = a;
        }
      }

      const parsedTeachers = Array.isArray(teachers)
        ? teachers
        : teachers
        ? teachers.split(',').map((t) => t.trim()).filter(Boolean)
        : teacherName
        ? [teacherName.trim()]
        : [];

      const resolvedTeacherName = parsedTeachers.length > 0 ? parsedTeachers.join(', ') : teacherName ? teacherName.trim() : '';

      newUser = await Student.create({
        name: name.trim(),
        phoneNumber: phoneNumber && phoneNumber.trim() ? phoneNumber.trim() : undefined,
        alternativePhoneNumber: alternativePhoneNumber && alternativePhoneNumber.trim() ? alternativePhoneNumber.trim() : null,
        email: email && email.trim() ? email.toLowerCase().trim() : undefined,
        alternativeEmail: alternativeEmail ? alternativeEmail.toLowerCase().trim() : '',
        dob: dob || null,
        age: calculatedAge,
        city: city ? city.trim() : '',
        state: state ? state.trim() : '',
        status: status === 'Left' ? 'Left' : 'Active',
        isActive: isStudentActive,
        teacherName: resolvedTeacherName,
        teachers: parsedTeachers,
        fee: Number(fee) || 0,
        batchName: batchName ? batchName.trim() : '',
        gst: gst === 'YES' ? 'YES' : 'NO',
        enrollmentNo: cleanEnrollmentNo,
        instruments: parsedInstruments,
        studentLevel: studentLevel || 'Beginner',
        enrolledCreditBalance: Number(enrolledCreditBalance) || 0,
        guardianName: guardianName ? guardianName.trim() : '',
        address: address ? address.trim() : '',
        avatarUrl: req.body.avatarUrl || req.body.avatar || null,
        avatar: req.body.avatarUrl || req.body.avatar || null,
        role: 'STUDENT',
        notes: notes ? notes.trim() : '',
      });
    }

    return successResponse(
      res,
      { user: newUser },
      `${assignedRole.toLowerCase()} record created successfully in dedicated collection.`,
      statusCodes.CREATED
    );
  } catch (err) {
    next(err);
  }
};

// Update user in their respective collection (Admin Edit Details)
const updateUser = async (req, res, next) => {
  try {
    const accountInfo = await findAccountById(req.params.id);
    if (!accountInfo) {
      return errorResponse(res, 'Account not found.', statusCodes.NOT_FOUND);
    }

    const { Model } = accountInfo;
    const updateData = { ...req.body };

    if (typeof updateData.instruments === 'string') {
      updateData.instruments = updateData.instruments.split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (updateData.teachers !== undefined) {
      const parsedTeachers = Array.isArray(updateData.teachers)
        ? updateData.teachers
        : typeof updateData.teachers === 'string'
        ? updateData.teachers.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
      updateData.teachers = parsedTeachers;
      if (parsedTeachers.length > 0) {
        updateData.teacherName = parsedTeachers.join(', ');
      }
    } else if (updateData.teacherName && (!updateData.teachers || updateData.teachers.length === 0)) {
      updateData.teachers = updateData.teacherName.split(',').map((t) => t.trim()).filter(Boolean);
    }

    if (updateData.dob && (updateData.age === undefined || updateData.age === null || updateData.age === '')) {
      const birthDate = new Date(updateData.dob);
      if (!isNaN(birthDate.getTime())) {
        const today = new Date();
        let a = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) a--;
        if (a >= 0 && a < 120) updateData.age = a;
      }
    } else if (updateData.age !== undefined && updateData.age !== null && updateData.age !== '') {
      updateData.age = Number(updateData.age);
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

    if (updateData.enrolledCreditBalance !== undefined) {
      updateData.enrolledCreditBalance = Number(updateData.enrolledCreditBalance);
    }

    if (updateData.fee !== undefined) {
      updateData.fee = Number(updateData.fee) || 0;
    }

    if (updateData.status !== undefined) {
      updateData.status = updateData.status === 'Left' ? 'Left' : 'Active';
      updateData.isActive = updateData.status === 'Active';
    } else if (updateData.isActive !== undefined) {
      updateData.status = updateData.isActive ? 'Active' : 'Left';
    }

    if (updateData.enrollmentNo && typeof updateData.enrollmentNo === 'string') {
      updateData.enrollmentNo = updateData.enrollmentNo.trim().toUpperCase();
    }

    if (updateData.gst !== undefined) {
      updateData.gst = updateData.gst === 'YES' ? 'YES' : 'NO';
    }

    if (updateData.avatarUrl !== undefined || updateData.avatar !== undefined) {
      const av = updateData.avatarUrl !== undefined ? updateData.avatarUrl : updateData.avatar;
      updateData.avatarUrl = av || null;
      updateData.avatar = av || null;
    }

    const updated = await Model.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });

    return successResponse(res, { user: updated }, 'Details updated successfully.');
  } catch (err) {
    next(err);
  }
};

// Delete user from their respective collection
const deleteUser = async (req, res, next) => {
  try {
    const accountInfo = await findAccountById(req.params.id);
    if (!accountInfo) {
      return errorResponse(res, 'Account not found.', statusCodes.NOT_FOUND);
    }

    const { Model } = accountInfo;
    await Model.findByIdAndDelete(req.params.id);

    return successResponse(res, null, 'Account deleted successfully.');
  } catch (err) {
    next(err);
  }
};

// Get profile of authenticated user
const getMyProfile = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (userId === 'dev_admin_id' || String(userId).includes('dev_admin')) {
      const admin = await Admin.findOne();
      return successResponse(res, {
        user: admin || {
          _id: 'dev_admin_id',
          id: 'dev_admin_id',
          name: 'Development Admin',
          email: 'admin@saptaswar.com',
          role: 'ADMIN',
        },
        role: admin?.role || 'ADMIN',
      });
    }

    const accountInfo = await findAccountById(userId);
    if (accountInfo) {
      return successResponse(res, { user: accountInfo.account, role: accountInfo.type });
    }
    const User = require('../models/User');
    const user = (mongoose.Types.ObjectId.isValid(userId) ? await User.findById(userId) : null) || await User.findOne();
    return successResponse(res, { user: user || req.user, role: user?.role || req.user.role });
  } catch (err) {
    next(err);
  }
};

// Update profile (Name, Avatar, Phone, etc.) of authenticated user
const updateProfile = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const {
      name,
      avatarUrl,
      avatar,
      profilePic,
      phoneNumber,
      alternativePhoneNumber,
      email,
      alternativeEmail,
      dob,
      age,
      city,
      state,
      guardianName,
      address,
      notes,
      instruments,
      studentLevel,
    } = req.body;

    const resolvedAvatar = avatarUrl !== undefined ? avatarUrl : (avatar !== undefined ? avatar : profilePic);

    const accountInfo = await findAccountById(userId);
    if (accountInfo) {
      const { account } = accountInfo;
      if (name) account.name = name.trim();
      if (resolvedAvatar !== undefined) {
        account.avatarUrl = resolvedAvatar;
        account.avatar = resolvedAvatar;
      }
      if (phoneNumber !== undefined) {
        account.phoneNumber = phoneNumber ? phoneNumber.trim() : undefined;
      }
      if (alternativePhoneNumber !== undefined) {
        account.alternativePhoneNumber = alternativePhoneNumber ? alternativePhoneNumber.trim() : null;
      }
      if (email && email.trim()) {
        account.email = email.toLowerCase().trim();
      }
      if (alternativeEmail !== undefined) {
        account.alternativeEmail = alternativeEmail ? alternativeEmail.toLowerCase().trim() : '';
      }
      if (dob !== undefined) {
        account.dob = dob ? dob.trim() : null;
        if (dob && (age === undefined || age === null || age === '')) {
          const birthDate = new Date(dob);
          if (!isNaN(birthDate.getTime())) {
            const today = new Date();
            let a = today.getFullYear() - birthDate.getFullYear();
            const m = today.getMonth() - birthDate.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) a--;
            if (a >= 0 && a < 120) account.age = a;
          }
        }
      }
      if (age !== undefined && age !== null && age !== '') {
        account.age = Number(age);
      }
      if (city !== undefined) account.city = city.trim();
      if (state !== undefined) account.state = state.trim();
      if (guardianName !== undefined) account.guardianName = guardianName.trim();
      if (address !== undefined) account.address = address.trim();
      if (notes !== undefined) account.notes = notes.trim();
      if (req.body.bio !== undefined) {
        account.bio = req.body.bio.trim();
        account.notes = req.body.bio.trim();
      }
      if (req.body.qualification !== undefined) account.qualification = req.body.qualification.trim();
      if (req.body.experienceYears !== undefined && req.body.experienceYears !== '') {
        account.experienceYears = Number(req.body.experienceYears);
      }
      if (studentLevel) account.studentLevel = studentLevel;
      if (instruments) {
        account.instruments = Array.isArray(instruments)
          ? instruments
          : instruments.split(',').map((s) => s.trim()).filter(Boolean);
      }

      await account.save();

      const User = require('../models/User');
      await User.findByIdAndUpdate(account._id, {
        ...(name ? { name: name.trim() } : {}),
        ...(resolvedAvatar !== undefined ? { avatarUrl: resolvedAvatar } : {}),
      }).catch(() => {});

      return successResponse(res, { user: account }, 'Profile updated successfully.');
    }

    const User = require('../models/User');
    let u = await User.findById(userId);
    if (!u) {
      u = await User.findOne({ email: req.user.email });
      if (!u) {
        u = await User.create({
          name: name || req.user.name || 'Student',
          role: req.user.role || 'STUDENT',
          email: req.user.email || 'student@academy.com',
          avatarUrl: resolvedAvatar || '',
        });
      }
    }

    if (name) u.name = name.trim();
    if (resolvedAvatar !== undefined) u.avatarUrl = resolvedAvatar;
    if (phoneNumber !== undefined) u.phoneNumber = phoneNumber ? phoneNumber.trim() : undefined;
    if (city !== undefined) u.city = city.trim();
    if (state !== undefined) u.state = state.trim();
    await u.save();

    return successResponse(res, { user: u }, 'Profile updated successfully.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getMyProfile,
  updateProfile,
};

