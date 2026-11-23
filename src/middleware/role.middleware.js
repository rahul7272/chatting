const { errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

/**
 * Role-Based Access Control Middleware (VikasBuilds State 6: Permission Denied)
 * Returns structured 403 Forbidden explaining missing roles and required permissions.
 */
const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return errorResponse(res, 'User identity not found. Authentication required.', statusCodes.UNAUTHORIZED);
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(statusCodes.FORBIDDEN || 403).json({
        success: false,
        code: 'PERMISSION_DENIED',
        message: `Access denied. Role '${req.user.role}' is not authorized to access this resource.`,
        requiredRoles: allowedRoles,
        currentRole: req.user.role,
        retryable: false,
      });
    }

    next();
  };
};

module.exports = { authorize };
