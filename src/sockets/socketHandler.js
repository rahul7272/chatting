const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const socketEvents = require('../constants/socketEvents');
const { registerChatHandlers } = require('./chatSocket');
const { registerPresenceHandlers } = require('./presenceSocket');

const setupSockets = (io) => {
  // Socket authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, jwtConfig.secret);
        socket.userId = decoded.userId;
        socket.userRole = decoded.role;
        return next();
      } catch (err) {
        console.warn('[Socket Auth] Invalid token provided:', err.message);
      }
    }
    // Allow connection even without token for initial dev, but record unauthenticated
    socket.userId = null;
    next();
  });

  io.on(socketEvents.CONNECTION, (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}, User: ${socket.userId || 'Guest'}`);

    // Register presence and chat modules
    registerPresenceHandlers(io, socket);
    registerChatHandlers(io, socket);
  });
};

module.exports = { setupSockets };
