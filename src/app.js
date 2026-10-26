const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const routes = require('./routes');
const errorHandler = require('./middleware/error.middleware');
const connectDB = require('./config/db');

const app = express();

// Ensure uploads directory and subdirectories exist
const uploadsDir = path.join(__dirname, '../uploads');
const uploadSubdirs = ['documents', 'images', 'audio', 'videos'];
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
uploadSubdirs.forEach((sub) => {
  const p = path.join(uploadsDir, sub);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
});

// Security and utility middleware
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static uploads (covers /uploads/audio/..., /uploads/images/..., etc.)
app.use('/uploads', express.static(uploadsDir));

// Fallback resolver: if legacy requests omit the subfolder, search across subfolders
app.use('/uploads/:fileName', (req, res, next) => {
  const fileName = req.params.fileName;
  for (const dir of uploadSubdirs) {
    const candidate = path.join(uploadsDir, dir, fileName);
    if (fs.existsSync(candidate)) {
      return res.sendFile(candidate);
    }
  }
  next();
});
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Health check endpoint with DB state
app.get('/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbState = states[mongoose.connection.readyState] || 'unknown';
  const isHealthy = mongoose.connection.readyState === 1;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'OK' : 'DEGRADED',
    database: {
      status: dbState,
      readyState: mongoose.connection.readyState,
    },
    uptime: process.uptime(),
    timestamp: new Date(),
    service: 'Academy Learning & Communication Backend',
  });
});

// Fast-fail middleware: if DB is disconnected, immediately attempt reconnect and notify client
app.use('/api/v1', (req, res, next) => {
  if (mongoose.connection.readyState === 0) {
    connectDB(); // Ensure reconnection is actively triggered
    return res.status(503).json({
      success: false,
      message: 'Database connection is temporarily unavailable. Reconnecting, please try again in a few seconds.',
      retryAfter: 5,
    });
  }
  next();
});

// API Routes
app.use('/api/v1', routes);

// Global Error Handler
app.use(errorHandler);

module.exports = app;
