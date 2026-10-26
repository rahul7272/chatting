const socketEvents = require('../constants/socketEvents');
const Message = require('../models/Message');

const registerChatHandlers = (io, socket) => {
  // Join specific group room
  socket.on(socketEvents.JOIN_ROOM, ({ groupId }) => {
    socket.join(`group:${groupId}`);
    console.log(`[Socket] Socket ${socket.id} joined group:${groupId}`);
  });

  // Leave room
  socket.on(socketEvents.LEAVE_ROOM, ({ groupId }) => {
    socket.leave(`group:${groupId}`);
  });

  // Typing indicators
  socket.on(socketEvents.TYPING_START, ({ groupId, userName }) => {
    socket.to(`group:${groupId}`).emit(socketEvents.USER_TYPING, {
      userId: socket.userId,
      userName,
      groupId,
    });
  });

  socket.on(socketEvents.TYPING_STOP, ({ groupId }) => {
    socket.to(`group:${groupId}`).emit(socketEvents.USER_STOP_TYPING, {
      userId: socket.userId,
      groupId,
    });
  });

  // Message read receipts
  socket.on(socketEvents.MESSAGE_READ, async ({ messageId, groupId, userId, name, avatarUrl, role }) => {
    try {
      const uId = socket.userId || userId;
      if (uId && messageId) {
        const reader = {
          userId: uId.toString(),
          name: name || socket.userName || 'Member',
          avatarUrl: avatarUrl || '',
          role: (role || 'STUDENT').toUpperCase(),
          seenAt: new Date(),
        };

        const updated = await Message.findByIdAndUpdate(
          messageId,
          {
            $addToSet: {
              readBy: uId,
              seenBy: reader,
            },
          },
          { new: true }
        );

        io.to(`group:${groupId}`).emit(socketEvents.MESSAGE_READ_UPDATE, {
          messageId,
          groupId,
          reader,
          seenByCount: updated?.seenBy?.length || 1,
        });
      }
    } catch (e) {
      console.error('[Socket] message_read error:', e.message);
    }
  });
};

module.exports = { registerChatHandlers };
