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
    } catch (e) {
      ws.groupId = null;
    }

    console.log(`[WebSocket] Client connected via /ws. Active rooms: [${Array.from(ws.rooms).join(', ')}], Total clients: ${wss.clients.size}`);

    ws.on('message', (messageRaw) => {
      try {
        const payload = JSON.parse(messageRaw.toString());
        if (payload.action === 'join' && payload.groupId) {
          const gid = payload.groupId.toString();
          ws.rooms.add(gid);
          ws.groupId = gid;
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
        } else if (payload.action === 'message_read' && payload.messageId) {
          const Message = require('../models/Message');
          const uId = ws.userId || payload.userId;
          if (uId) {
            const reader = {
              userId: uId.toString(),
              name: payload.name || 'Member',
              avatarUrl: payload.avatarUrl || '',
              role: (payload.role || 'STUDENT').toUpperCase(),
              seenAt: new Date(),
            };
            Message.findByIdAndUpdate(
              payload.messageId,
              {
                $addToSet: {
                  readBy: uId,
                  seenBy: reader,
                },
              },
              { new: true }
            )
              .then((updated) => {
                broadcast(
                  'message_read_update',
                  {
                    messageId: payload.messageId,
                    groupId: payload.groupId || ws.groupId,
                    reader,
                    seenByCount: updated?.seenBy?.length || 1,
                  },
                  payload.groupId || ws.groupId
                );
              })
              .catch(() => {});
          }
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

module.exports = { initSocket, getIO, getWSS, broadcast };

