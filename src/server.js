const http = require('http');
const app = require('./app');
const env = require('./config/env');
const connectDB = require('./config/db');
const { initSocket } = require('./config/socket');
const { setupSockets } = require('./sockets/socketHandler');

const server = http.createServer(app);

// Initialize Socket.IO
const io = initSocket(server);
setupSockets(io);

// Start server after attempting DB connection
const startServer = async () => {
  await connectDB();

  server.listen(env.port, () => {
    console.log(`====================================================`);
    console.log(`🚀 Academy Server running on http://localhost:${env.port}`);
    console.log(`📡 Socket.IO gateway active on port ${env.port}`);
    console.log(`🌍 Environment: ${env.nodeEnv}`);
    console.log(`====================================================`);
  });

  // Automated Background Dispatcher for T-15m and T-5m Class Alerts
  const notificationController = require('./controllers/notification.controller');
  setInterval(() => {
    notificationController.triggerClassAlerts(null, null, null).catch((err) => {
      // Background catch
    });
  }, 60 * 1000); // Check every 60 seconds
};

startServer();

module.exports = { server, app };
