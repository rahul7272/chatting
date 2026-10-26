const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

let firebaseApp = null;

const initFirebase = () => {
  if (firebaseApp) return firebaseApp;

  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || './config/firebaseServiceAccount.json';
    const absolutePath = path.resolve(process.cwd(), serviceAccountPath);

    if (fs.existsSync(absolutePath)) {
      const serviceAccount = require(absolutePath);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || 'chatiing-b9ee4',
      });
      logger.info('[Firebase Admin] Initialized with service account certificate.');
    } else {
      // Initialize with default application credentials if running in cloud / local dev mode
      firebaseApp = admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'chatiing-b9ee4',
      });
      logger.info('[Firebase Admin] Initialized with project ID (chatiing-b9ee4).');
    }
  } catch (error) {
    logger.warn(`[Firebase Admin] Notice: ${error.message}. Running in simulated mode.`);
  }

  return firebaseApp;
};

module.exports = { initFirebase, admin };
