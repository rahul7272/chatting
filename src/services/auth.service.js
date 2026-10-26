const User = require('../models/User');
const jwtHelper = require('../utils/jwtHelper');
const { ROLES } = require('../constants/roles');

class AuthService {
  async authenticateOtp(phoneNumber, otp, name) {
    let user = await User.findOne({ phoneNumber });
    if (!user) {
      user = await User.create({
        name: name || `Student ${phoneNumber.slice(-4)}`,
        phoneNumber,
        role: ROLES.STUDENT,
        enrolledCreditBalance: 0, // Default zero credit balance
      });
    }

    const payload = { userId: user._id, role: user.role };
    const accessToken = jwtHelper.generateAccessToken(payload);
    const refreshToken = jwtHelper.generateRefreshToken(payload);

    return { user, accessToken, refreshToken };
  }

  async getUserById(userId) {
    return await User.findById(userId);
  }
}

module.exports = new AuthService();
