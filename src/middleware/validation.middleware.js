const { errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_REGEX = /^\+?[0-9]{10,13}$/;

/**
 * Validates request payload against required fields
 * @param {Array<string>} requiredFields - List of required keys in req.body
 */
const validateBody = (requiredFields = []) => {
  return (req, res, next) => {
    const missing = [];
    const fieldErrors = {};

    for (const field of requiredFields) {
      const val = req.body[field];
      if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
        missing.push(field);
        fieldErrors[field] = `${field} is required.`;
      }
    }

    if (missing.length > 0) {
      return res.status(statusCodes.UNPROCESSABLE_ENTITY || 422).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: `Validation failed: Missing required fields (${missing.join(', ')})`,
        missing,
        fieldErrors,
        retryable: false,
      });
    }

    next();
  };
};

/**
 * VikasBuilds State 09: Validation State
 * Flexible schema-driven field validator that validates formats and returns structured field errors
 * @param {Object} schema - e.g. { email: { type: 'email', required: false }, phone: { type: 'phone' } }
 */
const validateSchema = (schema = {}) => {
  return (req, res, next) => {
    const fieldErrors = {};

    for (const [field, rules] of Object.entries(schema)) {
      const val = req.body[field];
      const isPresent = val !== undefined && val !== null && (typeof val === 'string' ? val.trim() !== '' : true);

      if (rules.required && !isPresent) {
        fieldErrors[field] = rules.message || `${field} is required.`;
        continue;
      }

      if (isPresent && typeof val === 'string') {
        const cleanVal = val.trim();

        if (rules.type === 'email' && !EMAIL_REGEX.hasMatch ? !EMAIL_REGEX.test(cleanVal) : false) {
          fieldErrors[field] = rules.message || 'Please provide a valid email address.';
        } else if (rules.type === 'phone') {
          const digitsOnly = cleanVal.replace(/[\s\-]/g, '');
          if (!PHONE_REGEX.test(digitsOnly)) {
            fieldErrors[field] = rules.message || 'Please provide a valid 10-digit phone number.';
          }
        } else if (rules.minLength && cleanVal.length < rules.minLength) {
          fieldErrors[field] = rules.message || `${field} must be at least ${rules.minLength} characters.`;
        } else if (rules.maxLength && cleanVal.length > rules.maxLength) {
          fieldErrors[field] = rules.message || `${field} cannot exceed ${rules.maxLength} characters.`;
        }
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(statusCodes.UNPROCESSABLE_ENTITY || 422).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed. Please correct the highlighted errors.',
        fieldErrors,
        retryable: false,
      });
    }

    next();
  };
};

module.exports = {
  validateBody,
  validateSchema,
  EMAIL_REGEX,
  PHONE_REGEX,
};
