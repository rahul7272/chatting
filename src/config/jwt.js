const env = require('./env');

module.exports = {
  secret: env.jwt.secret,
  expiresIn: env.jwt.expiresIn,
  refreshSecret: env.jwt.refreshSecret,
  refreshExpiresIn: env.jwt.refreshExpiresIn,
};
