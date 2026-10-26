const socketEvents = require('../constants/socketEvents');
const User = require('../models/User');
const logger = require('../utils/logger');

// In-memory active user registry: Map<userId, Set<socketId>>
const activeUsers = new Map();

const registerPresenceHandlers = (io, socket) => {
  const userId = socket.userId;

  if (userId) {
    if (!activeUsers.has(userId)) {
      activeUsers.set(userId, new Set());
    }
    activeUsers.get(userId).add(socket.id);

    // Broadcast user presence
    socket.broadcast.emit(socketEvents.USER_ONLINE, {
      userId,
      timestamp: new Date(),
    });

    // Update last seen in database
    User.findByIdAndUpdate(userId, { lastSeenAt: new Date() }).catch((err) =>
      logger.warn(`Failed to update last seen for user ${userId}:`, err.message)
    );
  }

  socket.on(socketEvents.DISCONNECT, () => {
    if (userId && activeUsers.has(userId)) {
      const socketSet = activeUsers.get(userId);
      socketSet.delete(socket.id);

      // If user has no more active socket connections, mark offline
      if (socketSet.size === 0) {
        activeUsers.delete(userId);
        const lastSeen = new Date();
        socket.broadcast.emit(socketEvents.USER_OFFLINE, {
          userId,
          lastSeen,
        });

        User.findByIdAndUpdate(userId, { lastSeenAt: lastSeen }).catch((err) =>
          logger.warn(`Failed to update last seen on disconnect:`, err.message)
        );
      }
    }
  });
};

const isUserOnline = (userId) => {
  return activeUsers.has(userId) && activeUsers.get(userId).size > 0;
};

module.exports = { registerPresenceHandlers, isUserOnline };
