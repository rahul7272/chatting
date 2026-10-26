const logger = require('../utils/logger');
const statusCodes = require('../constants/statusCodes');

const errorHandler = (err, req, res, next) => {
  logger.error(err.message, err.stack);

  let statusCode = err.statusCode || statusCodes.INTERNAL_SERVER_ERROR;
  let message = err.message || 'An unexpected internal error occurred.';

  // Catch Mongoose buffering timeouts specifically
  if (err.name === 'MongooseError' && err.message.includes('buffering timed out')) {
    statusCode = statusCodes.SERVICE_UNAVAILABLE || 503;
    message = 'Database request timed out while waiting for connection. The server is reconnecting to the database; please retry in a few moments.';
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;

