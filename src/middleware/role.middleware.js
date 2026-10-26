const { errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return errorResponse(res, 'User identity not found.', statusCodes.UNAUTHORIZED);
    }

    if (!allowedRoles.includes(req.user.role)) {
      return errorResponse(
        res,
        `Forbidden: Role '${req.user.role}' is not authorized to access this resource.`,
        statusCodes.FORBIDDEN
      );
    }

    next();
  };
};

module.exports = { authorize };
