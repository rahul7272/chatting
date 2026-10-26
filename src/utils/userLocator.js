const mongoose = require('mongoose');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Admin = require('../models/Admin');

/**
 * Builds a flexible phone matching query that matches exact input,
 * stripped digits, or whitespace-separated variations (e.g. "+91 98290 12345" vs "9829012345").
 */
const buildPhoneQuery = (phoneNumber) => {
  if (!phoneNumber) return null;
  const cleanPhone = phoneNumber.trim();
  const digits = cleanPhone.replace(/\D/g, '');

  const conditions = [
    { phoneNumber: cleanPhone },
    { alternativePhoneNumber: cleanPhone },
  ];

  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    const pattern = new RegExp(last10.split('').join('\\s*'));
    conditions.push({ phoneNumber: pattern });
    conditions.push({ alternativePhoneNumber: pattern });
  }

  return { $or: conditions };
};

/**
 * Builds an email matching query checking primary and alternative email.
 */
const buildEmailQuery = (email) => {
  if (!email) return null;
  const cleanEmail = email.toLowerCase().trim();
  return {
    $or: [
      { email: cleanEmail },
      { alternativeEmail: cleanEmail },
    ],
  };
};

const findAccountById = async (id) => {
  if (!id) return null;

  // Handle mock development admin ID gracefully
  if (id === 'dev_admin_id' || String(id).toLowerCase().includes('dev_admin')) {
    const admin = await Admin.findOne();
    if (admin) return { account: admin, type: admin.role || 'ADMIN', Model: Admin };
    return {
      account: {
        _id: 'dev_admin_id',
        id: 'dev_admin_id',
        name: 'Development Admin',
        email: 'admin@saptaswar.com',
        role: 'ADMIN',
      },
      type: 'ADMIN',
      Model: Admin,
    };
  }

  // Prevent Mongoose CastError if id is not a valid 24-character hexadecimal ObjectId
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  const [student, teacher, admin] = await Promise.all([
    Student.findById(id),
    Teacher.findById(id),
    Admin.findById(id),
  ]);
  if (student) return { account: student, type: 'STUDENT', Model: Student };
  if (teacher) return { account: teacher, type: 'TEACHER', Model: Teacher };
  if (admin) return { account: admin, type: admin.role, Model: Admin };
  return null;
};

const findAccountByEmail = async (email, role = null) => {
  if (!email) return null;
  const query = buildEmailQuery(email);
  if (!query) return null;

  const targetRole = role ? role.toUpperCase() : null;

  if (targetRole === 'TEACHER') {
    const teacher = await Teacher.findOne(query);
    if (teacher) return { account: teacher, type: 'TEACHER', Model: Teacher };
    return null;
  }

  if (targetRole === 'STUDENT') {
    const student = await Student.findOne(query);
    if (student) return { account: student, type: 'STUDENT', Model: Student };
    return null;
  }

  const [student, teacher, admin] = await Promise.all([
    Student.findOne(query),
    Teacher.findOne(query),
    Admin.findOne(query),
  ]);
  if (student) return { account: student, type: 'STUDENT', Model: Student };
  if (teacher) return { account: teacher, type: 'TEACHER', Model: Teacher };
  if (admin) return { account: admin, type: admin.role, Model: Admin };
  return null;
};

const findAccountByPhone = async (phoneNumber, role = null) => {
  if (!phoneNumber) return null;
  const query = buildPhoneQuery(phoneNumber);
  if (!query) return null;

  const targetRole = role ? role.toUpperCase() : null;

  if (targetRole === 'TEACHER') {
    const teacher = await Teacher.findOne(query);
    if (teacher) return { account: teacher, type: 'TEACHER', Model: Teacher };
    return null;
  }

  if (targetRole === 'STUDENT') {
    const student = await Student.findOne(query);
    if (student) return { account: student, type: 'STUDENT', Model: Student };
    return null;
  }

  const [student, teacher, admin] = await Promise.all([
    Student.findOne(query),
    Teacher.findOne(query),
    Admin.findOne(query),
  ]);
  if (student) return { account: student, type: 'STUDENT', Model: Student };
  if (teacher) return { account: teacher, type: 'TEACHER', Model: Teacher };
  if (admin) return { account: admin, type: admin.role, Model: Admin };
  return null;
};

module.exports = {
  findAccountById,
  findAccountByEmail,
  findAccountByPhone,
  buildPhoneQuery,
  buildEmailQuery,
};

