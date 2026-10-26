require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/academy_db',
  jwt: {
    secret: process.env.JWT_SECRET || 'fallback_secret_key_123',
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'fallback_refresh_key_123',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '60d'
  },
  cors: {
    clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
    adminUrl: process.env.ADMIN_URL || 'http://localhost:5173'
  }
};
