const socketEvents = require('../constants/socketEvents');
const chatService = require('../services/chat.service');
const { broadcast } = require('../config/socket');
const logger = require('../utils/logger');

const registerChatHandlers = (io, socket) => {
  // Join specific group room
  socket.on(socketEvents.JOIN_ROOM, ({ groupId }) => {
    if (groupId) {
      const room = `group:${groupId}`;
      socket.join(room);
      console.log(`[Socket.IO] Client ${socket.id} joined room ${room}`);
      socket.emit('joined', { groupId });
    }
  });

  // Leave specific group room
  socket.on(socketEvents.LEAVE_ROOM, ({ groupId }) => {
    if (groupId) {
      const room = `group:${groupId}`;
      socket.leave(room);
      console.log(`[Socket.IO] Client ${socket.id} left room ${room}`);
    }
  });

  // Real-time message submission via Socket.IO
  socket.on(socketEvents.SEND_MESSAGE, async (data) => {
    try {
      if (data && data.groupId) {
        const senderContext = {
          userId: socket.userId || data.senderId,
          name: socket.userName || data.senderName,
          avatarUrl: data.avatarUrl || data.senderAvatar,
          role: socket.userRole || data.role || 'STUDENT',
        };
        await chatService.createMessage(data.groupId, data, senderContext);
      }
    } catch (e) {
      logger.warn('[Socket.IO send_message error]:', e.message);
      socket.emit('error', { message: e.message });
    }
  });

  // Typing indicators broadcast universally
  socket.on(socketEvents.TYPING_START, ({ groupId, userName }) => {
    if (groupId) {
      broadcast(
        socketEvents.USER_TYPING,
        {
          userId: socket.userId,
          userName: userName || socket.userName || 'Member',
          groupId,
        },
        groupId
      );
    }
  });

  socket.on(socketEvents.TYPING_STOP, ({ groupId }) => {
    if (groupId) {
      broadcast(
        socketEvents.USER_STOP_TYPING,
        {
          userId: socket.userId,
          groupId,
        },
        groupId
      );
    }
  });

  // Message read receipts
  socket.on(socketEvents.MESSAGE_READ, async ({ messageId, groupId, userId, name, avatarUrl, role }) => {
    try {
      const uId = socket.userId || userId;
      if (messageId && uId) {
        await chatService.markMessageAsRead(messageId, {
          userId: uId,
          name: name || socket.userName || 'Member',
          avatarUrl: avatarUrl || '',
          role: role || socket.userRole || 'STUDENT',
        });
      }
    } catch (e) {
      logger.warn('[Socket.IO message_read error]:', e.message);
    }
  });

  // Reaction toggle via Socket.IO
  socket.on(socketEvents.MESSAGE_REACTION, async ({ messageId, emoji }) => {
    try {
      if (messageId && emoji) {
        await chatService.toggleReaction(messageId, emoji, {
          userId: socket.userId,
          name: socket.userName || 'Member',
        });
      }
    } catch (e) {
      logger.warn('[Socket.IO reaction error]:', e.message);
    }
  });

  // Message pin toggle via Socket.IO
  socket.on(socketEvents.MESSAGE_PINNED, async ({ messageId }) => {
    try {
      if (messageId) {
        await chatService.togglePin(messageId, {
          userId: socket.userId,
          name: socket.userName || 'Admin',
          role: socket.userRole || 'ADMIN',
        });
      }
    } catch (e) {
      logger.warn('[Socket.IO pin error]:', e.message);
    }
  });

  // Poll voting via Socket.IO
  socket.on('poll_vote', async ({ messageId, optionIndex }) => {
    try {
      if (messageId && optionIndex !== undefined) {
        await chatService.votePoll(messageId, optionIndex, {
          userId: socket.userId,
          name: socket.userName || 'Member',
          role: socket.userRole || 'STUDENT',
        });
      }
    } catch (e) {
      logger.warn('[Socket.IO poll_vote error]:', e.message);
    }
  });
};

module.exports = { registerChatHandlers };
