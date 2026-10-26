const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

let isConnecting = false;
let retryTimeout = null;

const mongooseOptions = {
  serverSelectionTimeoutMS: 30000, // 30s timeout to allow MongoDB Atlas DNS/SSL/wake-up
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
};

const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (isConnecting) {
    return;
  }

  isConnecting = true;
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  try {
    console.log(`[MongoDB] Connecting to database...`);
    const conn = await mongoose.connect(env.mongoUri, mongooseOptions);
    isConnecting = false;
    console.log(`[MongoDB] Successfully connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    isConnecting = false;
    console.error(`[MongoDB] Connection Error: ${error.message}`);
    
    // Check for common MongoDB Atlas IP whitelist or network issues
    if (error.name === 'MongoServerSelectionError' || error.message.includes('buffering timed out')) {
      console.warn(`[MongoDB Warning] Could not reach MongoDB cluster. Possible causes:`);
      console.warn(`  1. Your current IP address is not whitelisted in MongoDB Atlas (Network Access -> Add IP Address / Allow 0.0.0.0/0).`);
      console.warn(`  2. Internet connection is down or firewall is blocking port 27017.`);
      console.warn(`  3. The cluster is paused or restarting.`);
    }

    if (env.nodeEnv === 'production') {
      console.error(`[MongoDB] Exiting process in production mode.`);
      process.exit(1);
    } else {
      console.log(`[MongoDB] Scheduling retry in 5 seconds...`);
      retryTimeout = setTimeout(() => {
        connectDB();
      }, 5000);
    }
  }
};

// Event listeners for connection lifecycle
mongoose.connection.on('connected', () => {
  console.log(`[MongoDB Event] Connection established.`);
});

mongoose.connection.on('error', (err) => {
  console.error(`[MongoDB Event] Error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
  console.warn(`[MongoDB Event] Disconnected from database.`);
  // Automatically attempt reconnect in development or non-production
  if (!isConnecting && env.nodeEnv !== 'production') {
    console.log(`[MongoDB Event] Reconnection attempt in 5 seconds...`);
    if (retryTimeout) clearTimeout(retryTimeout);
    retryTimeout = setTimeout(() => {
      connectDB();
    }, 5000);
  }
});

const isConnected = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.isConnected = isConnected;

