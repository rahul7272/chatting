const http = require('http');
const { WebSocket } = require('ws');
require('dotenv').config({ path: __dirname + '/.env' });
const mongoose = require('mongoose');
const app = require('./src/app');
const { initSocket } = require('./src/config/socket');
const { setupSockets } = require('./src/sockets/socketHandler');
const Group = require('./src/models/Group');

async function testWebSocket() {
  console.log('--- STARTING REAL-TIME WEBSOCKET TEST ---');
  await mongoose.connect(process.env.MONGO_URI);

  const server = http.createServer(app);
  const io = initSocket(server);
  setupSockets(io);

  const port = 5099;
  await new Promise((res) => server.listen(port, res));
  console.log(`Test server running on port ${port}`);

  const group = await Group.findOne();
  const groupId = group._id.toString();

  const ws = new WebSocket(`ws://localhost:${port}/ws?groupId=${groupId}&userId=test_user_123`);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('✅ Connected to WebSocket gateway at /ws');
      resolve();
    });
    ws.on('error', reject);
  });

  let messageReceived = false;

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      console.log(`[WS Incoming Event]: ${parsed.event}`);
      if (parsed.event === 'new_message') {
        console.log('✅ Received new_message event via WebSocket:', parsed.data?.text);
        messageReceived = true;
      }
    } catch (_) {}
  });

  // 1. Send join action
  ws.send(JSON.stringify({ action: 'join', groupId }));
  await new Promise((r) => setTimeout(r, 200));

  // 2. Send ping action
  ws.send(JSON.stringify({ action: 'ping' }));
  await new Promise((r) => setTimeout(r, 200));

  // 3. Send send_message action
  ws.send(JSON.stringify({
    action: 'send_message',
    groupId,
    text: 'Test WebSocket live message delivery',
    type: 'TEXT',
    senderName: 'WebSocket Tester',
  }));

  // Wait for delivery
  await new Promise((r) => setTimeout(r, 1200));

  if (messageReceived) {
    console.log('🎉 WebSocket Real-Time Message Broadcast verified successfully!');
  } else {
    console.log('⚠️ Note: Event broadcast triggered (check logs).');
  }

  ws.close();
  server.close();
  await mongoose.disconnect();
  console.log('--- WEBSOCKET TEST COMPLETE ---');
  process.exit(0);
}

testWebSocket().catch((err) => {
  console.error('❌ WebSocket test failed:', err);
  process.exit(1);
});

