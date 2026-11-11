const { Server } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');
const env = require('./env');

let io = null;
let wss = null;

const initSocket = (httpServer) => {
  // 1. Socket.IO Server
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // 2. Native WebSocket Server for Flutter / Web clients (Path: /ws)
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.rooms = new Set();
    // Parse query params e.g. /ws?groupId=123
    try {
      const url = new URL(req.url, 'http://localhost');
      const qGroupId = url.searchParams.get('groupId');
      if (qGroupId) {
        ws.rooms.add(qGroupId.toString());
        ws.groupId = qGroupId.toString();
      }
      ws.userId = url.searchParams.get('userId') || null;
      ws.userName = url.searchParams.get('userName') || url.searchParams.get('name') || null;
    } catch (e) {
      ws.groupId = null;
    }

    console.log(`[WebSocket] Client connected via /ws. Active rooms: [${Array.from(ws.rooms).join(', ')}], Total clients: ${wss.clients.size}`);

    ws.on('message', async (messageRaw) => {
      try {
        const payload = JSON.parse(messageRaw.toString());
        const chatService = require('../services/chat.service');
        const socketEvents = require('../constants/socketEvents');

        if (payload.action === 'join' && payload.groupId) {
          const gid = payload.groupId.toString();
          ws.rooms.add(gid);
          ws.groupId = gid;
          if (payload.userId) ws.userId = payload.userId;
          if (payload.userName) ws.userName = payload.userName;
          console.log(`[WebSocket] Client joined room group:${gid}`);
          ws.send(JSON.stringify({ event: 'joined', groupId: gid }));
        } else if (payload.action === 'leave') {
          if (payload.groupId) {
            ws.rooms.delete(payload.groupId.toString());
            if (ws.groupId === payload.groupId.toString()) {
              ws.groupId = null;
            }
          } else {
            ws.rooms.clear();
            ws.groupId = null;
          }
        } else if (payload.action === 'ping') {
          ws.send(JSON.stringify({ event: 'pong' }));
        } else if (payload.action === 'send_message' && (payload.groupId || ws.groupId)) {
          const targetGid = payload.groupId || ws.groupId;
          const senderContext = {
            userId: ws.userId || payload.senderId || payload.userId,
            name: ws.userName || payload.senderName || payload.name,
            avatarUrl: payload.avatarUrl || payload.senderAvatar,
            role: payload.role || 'STUDENT',
          };
          chatService.createMessage(targetGid, payload, senderContext).catch((err) => {
            console.warn('[WS send_message error]:', err.message);
          });
        } else if (payload.action === 'typing_start' && (payload.groupId || ws.groupId)) {
          const targetGid = payload.groupId || ws.groupId;
          broadcast(
            socketEvents.USER_TYPING,
            {
              userId: ws.userId || payload.userId,
              userName: payload.userName || payload.name || ws.userName || 'Member',
              groupId: targetGid,
            },
            targetGid
          );
        } else if (payload.action === 'typing_stop' && (payload.groupId || ws.groupId)) {
          const targetGid = payload.groupId || ws.groupId;
          broadcast(
            socketEvents.USER_STOP_TYPING,
            {
              userId: ws.userId || payload.userId,
              groupId: targetGid,
            },
            targetGid
          );
        } else if (payload.action === 'message_read' && payload.messageId) {
          const uId = ws.userId || payload.userId;
          if (uId) {
            chatService.markMessageAsRead(payload.messageId, {
              userId: uId,
              name: payload.name || ws.userName || 'Member',
              avatarUrl: payload.avatarUrl || '',
              role: (payload.role || 'STUDENT').toUpperCase(),
            }).catch((err) => {
              console.warn('[WS message_read error]:', err.message);
            });
          }
        } else if (payload.action === 'reaction' && payload.messageId && payload.emoji) {
          chatService.toggleReaction(payload.messageId, payload.emoji, {
            userId: ws.userId || payload.userId,
            name: payload.name || ws.userName || 'Member',
          }).catch((err) => {
            console.warn('[WS reaction error]:', err.message);
          });
        } else if (payload.action === 'vote_poll' && payload.messageId && payload.optionIndex !== undefined) {
          chatService.votePoll(payload.messageId, payload.optionIndex, {
            userId: ws.userId || payload.userId,
            name: payload.name || ws.userName || 'Member',
            avatarUrl: payload.avatarUrl || '',
            role: payload.role || 'STUDENT',
          }).catch((err) => {
            console.warn('[WS vote_poll error]:', err.message);
          });
        } else if (payload.action === 'pin_message' && payload.messageId) {
          chatService.togglePin(payload.messageId, {
            userId: ws.userId || payload.userId,
            name: payload.name || ws.userName || 'Admin',
            role: payload.role || 'ADMIN',
          }).catch((err) => {
            console.warn('[WS pin_message error]:', err.message);
          });
        }
      } catch (err) {
        // Ignore unparseable frames
      }
    });

    ws.on('close', () => {
      console.log(`[WebSocket] Client disconnected from /ws. Remaining: ${wss.clients.size}`);
    });

    ws.on('error', (err) => {
      console.warn('[WebSocket] Client error:', err.message);
    });

    // Send initial connection acknowledgement
    ws.send(JSON.stringify({
      event: 'connected',
      message: 'Real-time WebSocket connection established.',
      timestamp: new Date().toISOString(),
    }));
  });

  return io;
};

const getIO = () => {
  return io;
};

const getWSS = () => {
  return wss;
};

/**
 * Universal broadcast function delivering events to Socket.IO and Native WebSocket clients
 */
const broadcast = (event, data, targetGroupId = null) => {
  const jsonString = JSON.stringify({
    event,
    data,
    groupId: targetGroupId,
    timestamp: new Date().toISOString(),
  });

  // A. Broadcast via Socket.IO
  if (io) {
    try {
      if (targetGroupId) {
        io.to(`group:${targetGroupId}`).emit(event, data);
      }
      // Also emit globally for admin dashboard / batch overview
      io.emit(event, { data, groupId: targetGroupId });
    } catch (e) {
      console.warn('[Socket.IO Broadcast Error]:', e.message);
    }
  }

  // B. Broadcast via Native WebSocket Server (/ws)
  if (wss && wss.clients) {
    const targetStr = targetGroupId ? targetGroupId.toString() : null;

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        const hasRooms = client.rooms && client.rooms.size > 0;
        const inTargetRoom = targetStr && client.rooms && client.rooms.has(targetStr);
        const matchesGroupId = targetStr && client.groupId === targetStr;
        const isGlobalListener = !hasRooms && !client.groupId;

        // Deliver if:
        // 1. targetGroupId is null (global event like batch create/archive)
        // 2. client is listening globally (admin console or dashboard)
        // 3. client has joined this specific target room
        if (!targetStr || isGlobalListener || inTargetRoom || matchesGroupId) {
          try {
            client.send(jsonString);
          } catch (e) {
            console.warn('[WS Send Error]:', e.message);
          }
        }
      }
    });
  }
};

/**
 * Deliver event strictly to specific userIds (matching ws.userId)
 */
const broadcastToUsers = (event, data, userIds = []) => {
  const idSet = new Set((userIds || []).map((id) => id.toString()));
  if (idSet.size === 0) return;

  const jsonString = JSON.stringify({
    event,
    data,
    targetUserIds: Array.from(idSet),
    timestamp: new Date().toISOString(),
  });

  if (wss && wss.clients) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client.userId && idSet.has(client.userId.toString())) {
        try {
          client.send(jsonString);
        } catch (e) {
          console.warn('[WS Targeted Send Error]:', e.message);
        }
      }
    });
  }
};

module.exports = { initSocket, getIO, getWSS, broadcast, broadcastToUsers };
