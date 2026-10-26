const { errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

/**
 * Validates request payload against required fields
 * @param {Array<string>} requiredFields - List of required keys in req.body
 */
const validateBody = (requiredFields = []) => {
  return (req, res, next) => {
    const missing = [];
    for (const field of requiredFields) {
      if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') {
        missing.push(field);
      }
    }

    if (missing.length > 0) {
      return errorResponse(
        res,
        `Validation failed: Missing required fields (${missing.join(', ')})`,
        statusCodes.BAD_REQUEST,
        missing
      );
    }

    next();
  };
};

module.exports = { validateBody };
