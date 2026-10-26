const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const jwtHelper = require('../utils/jwtHelper');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Admin = require('../models/Admin');
const { findAccountById, findAccountByEmail, findAccountByPhone } = require('../utils/userLocator');
const { ROLES } = require('../constants/roles');

// Request OTP
const requestOtp = async (req, res, next) => {
  try {
    const { phoneNumber, role } = req.body;
    if (!phoneNumber) {
      return errorResponse(res, 'Phone number is required.', statusCodes.BAD_REQUEST);
    }

    const cleanPhone = phoneNumber.trim();
    const isTeacher = role && role.toUpperCase() === 'TEACHER';

    if (isTeacher) {
      const teacherInfo = await findAccountByPhone(cleanPhone, 'TEACHER');
      if (!teacherInfo || !teacherInfo.account) {
        return errorResponse(
          res,
          'Access restricted: No teacher profile found for this phone number. Please contact your academy administrator to register your teacher account first.',
          statusCodes.NOT_FOUND
        );
      }
      if (teacherInfo.account.status === 'Left' || teacherInfo.account.status === 'Inactive') {
        return errorResponse(
          res,
          'Your teacher account is currently inactive. Please contact the academy administrator.',
          statusCodes.FORBIDDEN
        );
      }
    }

    // Default test verification code is 123456
    return successResponse(res, { phoneNumber, sent: true }, 'OTP dispatched successfully. (Dev default: 123456)');
  } catch (err) {
    next(err);
  }
};

// Verify OTP
const verifyOtp = async (req, res, next) => {
  try {
    const { phoneNumber, otp, name, role } = req.body;
    if (!phoneNumber || !otp) {
      return errorResponse(res, 'Phone number and OTP are required.', statusCodes.BAD_REQUEST);
    }

    if (otp !== '123456' && process.env.NODE_ENV !== 'production') {
      return errorResponse(res, 'Invalid OTP code.', statusCodes.UNAUTHORIZED);
    }

    const cleanPhone = phoneNumber.trim();
    const isTeacher = role && role.toUpperCase() === 'TEACHER';
    let accountInfo;
    let user;

    if (isTeacher) {
      // Teachers MUST already exist in the 'teachers' collection via Admin Panel
      accountInfo = await findAccountByPhone(cleanPhone, 'TEACHER');
      if (!accountInfo || !accountInfo.account) {
        return errorResponse(
          res,
          'Access restricted: No teacher profile found for this phone number. Please contact your academy administrator to register your teacher account.',
          statusCodes.FORBIDDEN
        );
      }
      if (accountInfo.account.status === 'Left' || accountInfo.account.status === 'Inactive') {
        return errorResponse(
          res,
          'Your teacher account is currently inactive. Please contact the academy administrator.',
          statusCodes.FORBIDDEN
        );
      }
      user = accountInfo.account;
    } else {
      // Student login / registration
      accountInfo = await findAccountByPhone(cleanPhone, 'STUDENT');
      if (!accountInfo) {
        // Create new student in dedicated 'students' collection
        user = await Student.create({
          name: name || `Student ${cleanPhone.slice(-4)}`,
          phoneNumber: cleanPhone,
          instruments: ['Harmonium'],
          studentLevel: 'Beginner',
          enrolledCreditBalance: 0,
        });
        accountInfo = { account: user, type: 'STUDENT' };
      } else {
        user = accountInfo.account;
      }
    }

    const payload = { userId: user._id, role: user.role || accountInfo.type };
    const accessToken = jwtHelper.generateAccessToken(payload);
    const refreshToken = jwtHelper.generateRefreshToken(payload);

    return successResponse(
      res,
      {
        accessToken,
        refreshToken,
        user,
      },
      'Authentication successful.'
    );
  } catch (err) {
    next(err);
  }
};

// Google OAuth Login
const googleAuth = async (req, res, next) => {
  try {
    const { email, name, avatarUrl, role } = req.body;
    if (!email) {
      return errorResponse(res, 'Email is required for Google Sign-In.', statusCodes.BAD_REQUEST);
    }

    const cleanEmail = email.toLowerCase().trim();
    const isTeacher = role && role.toUpperCase() === 'TEACHER';
    let accountInfo;
    let user;

    if (isTeacher) {
      // Teachers MUST already exist in the 'teachers' collection via Admin Panel
      accountInfo = await findAccountByEmail(cleanEmail, 'TEACHER');
      if (!accountInfo || !accountInfo.account) {
        return errorResponse(
          res,
          `Access restricted: No teacher profile found for "${cleanEmail}". Please contact your academy administrator to register your teacher account first.`,
          statusCodes.FORBIDDEN
        );
      }
      if (accountInfo.account.status === 'Left' || accountInfo.account.status === 'Inactive') {
        return errorResponse(
          res,
          'Your teacher account is currently inactive. Please contact the academy administrator.',
          statusCodes.FORBIDDEN
        );
      }
      user = accountInfo.account;
      if (avatarUrl && !user.avatarUrl && !user.avatar) {
        user.avatarUrl = avatarUrl;
        user.avatar = avatarUrl;
        await user.save();
      }
    } else {
      accountInfo = await findAccountByEmail(cleanEmail, 'STUDENT');
      if (!accountInfo) {
        // New user logging in via Google is created in the 'students' collection!
        user = await Student.create({
          name: name || 'Student Learner',
          email: cleanEmail,
          avatarUrl: avatarUrl || null,
          avatar: avatarUrl || null,
          instruments: ['Vocal', 'Harmonium'],
          studentLevel: 'Beginner',
          enrolledCreditBalance: 0,
        });
        accountInfo = { account: user, type: 'STUDENT' };
      } else {
        user = accountInfo.account;
        if (avatarUrl && !user.avatarUrl && !user.avatar) {
          user.avatarUrl = avatarUrl;
          user.avatar = avatarUrl;
          await user.save();
        }
      }
    }

    const payload = { userId: user._id, role: user.role || accountInfo.type };
    const accessToken = jwtHelper.generateAccessToken(payload);
    const refreshToken = jwtHelper.generateRefreshToken(payload);

    return successResponse(
      res,
      {
        accessToken,
        refreshToken,
        user,
      },
      'Google sign-in successful.'
    );
  } catch (err) {
    next(err);
  }
};

// Get current authenticated user profile
const getMe = async (req, res, next) => {
  try {
    if (req.user && req.user.userId === 'dev_admin_id') {
      return successResponse(res, {
        user: {
          _id: 'dev_admin_id',
          name: 'Development Admin',
          role: ROLES.ADMIN,
          status: 'Active',
        },
      });
    }

    const accountInfo = await findAccountById(req.user.userId);
    if (!accountInfo) {
      return errorResponse(res, 'Account not found.', statusCodes.NOT_FOUND);
    }
    return successResponse(res, { user: accountInfo.account });
  } catch (err) {
    next(err);
  }
};

// Refresh session token
const refreshToken = async (req, res, next) => {
  try {
    const incomingRefreshToken = req.body.refreshToken || req.body.token;
    if (!incomingRefreshToken) {
      return errorResponse(res, 'Refresh token is required.', statusCodes.BAD_REQUEST);
    }

    let decoded;
    try {
      decoded = jwtHelper.verifyRefreshToken(incomingRefreshToken);
    } catch (err) {
      return errorResponse(res, 'Invalid or expired refresh token. Please log in again.', statusCodes.UNAUTHORIZED);
    }

    const accountInfo = await findAccountById(decoded.userId);
    if (!accountInfo) {
      return errorResponse(res, 'Account no longer exists.', statusCodes.NOT_FOUND);
    }

    const payload = { userId: accountInfo.account._id, role: accountInfo.account.role || accountInfo.type };
    const newAccessToken = jwtHelper.generateAccessToken(payload);
    const newRefreshToken = jwtHelper.generateRefreshToken(payload);

    return successResponse(
      res,
      {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        user: accountInfo.account,
      },
      'Session token refreshed successfully.'
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  requestOtp,
  verifyOtp,
  googleAuth,
  getMe,
  refreshToken,
};
