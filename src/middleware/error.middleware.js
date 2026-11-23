const logger = require('../utils/logger');
const statusCodes = require('../constants/statusCodes');

/**
 * Standardized Global Error Middleware (VikasBuilds State 5: Error State)
 * Always returns consistent, user-safe error responses:
 * {
 *   success: false,
 *   code: string,
 *   message: string,
 *   retryable: boolean,
 *   errors?: array
 * }
 */
const errorHandler = (err, req, res, next) => {
  logger.error(`[ErrorMiddleware] ${req.method} ${req.originalUrl} - ${err.message}`, err.stack);

  let statusCode = err.statusCode || statusCodes.INTERNAL_SERVER_ERROR;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'An unexpected error occurred. Please try again.';
  let retryable = statusCode >= 500 || statusCode === 408 || statusCode === 429;
  let errors = err.errors || null;

  // 1. Mongoose Buffering / Database Connection Timeout
  if (err.name === 'MongooseError' && err.message.includes('buffering timed out')) {
    statusCode = statusCodes.SERVICE_UNAVAILABLE || 503;
    code = 'DATABASE_BUFFERING_TIMEOUT';
    message = 'Database is reconnecting. Please retry in a few moments.';
    retryable = true;
  }

  // 2. Mongoose Schema Validation Error
  if (err.name === 'ValidationError') {
    statusCode = statusCodes.UNPROCESSABLE_ENTITY || 422;
    code = 'VALIDATION_ERROR';
    message = Object.values(err.errors || {}).map((val) => val.message).join(', ');
    retryable = false;
  }

  // 3. Mongoose Cast Error (Invalid ObjectId / field type)
  if (err.name === 'CastError') {
    statusCode = statusCodes.BAD_REQUEST || 400;
    code = 'INVALID_IDENTIFIER';
    message = `Invalid identifier format for field: ${err.path}`;
    retryable = false;
  }

  // 4. MongoDB Duplicate Key (E11000)
  if (err.code === 11000) {
    statusCode = statusCodes.CONFLICT || 409;
    code = 'DUPLICATE_KEY';
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `An entry with this ${field} already exists.`;
    retryable = false;
  }

  // 4b. Mongoose Optimistic Concurrency Control (Version Conflict - VikasBuilds State 19)
  if (err.name === 'VersionError') {
    statusCode = statusCodes.CONFLICT || 409;
    code = 'VERSION_CONFLICT';
    message = 'This record was modified by another user. Please refresh and review before saving.';
    retryable = false;
  }

  // 4c. Request Timeout / Gateway Timeout (VikasBuilds State 18)
  if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT' || err.message?.toLowerCase().includes('timed out')) {
    statusCode = statusCodes.REQUEST_TIMEOUT || 408;
    code = 'REQUEST_TIMEOUT';
    message = 'The server took too long to process your request. Please check status before re-submitting.';
    retryable = true;
  }

  // 5. JWT Authentication Errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = statusCodes.UNAUTHORIZED || 401;
    code = 'INVALID_TOKEN';
    message = 'Session token is invalid. Please sign in again.';
    retryable = false;
  }

  if (err.name === 'TokenExpiredError') {
    statusCode = statusCodes.UNAUTHORIZED || 401;
    code = 'TOKEN_EXPIRED';
    message = 'Your session has expired. Please refresh your session.';
    retryable = false;
  }

  res.status(statusCode).json({
    success: false,
    code,
    message,
    retryable,
    ...(errors && { errors }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
