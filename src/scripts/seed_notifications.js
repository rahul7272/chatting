const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { seedDummyNotifications } = require('../controllers/notification.controller');

async function run() {
  try {
    await connectDB();
    console.log('[Seed] Connected to DB, seeding dummy notices...');
    const result = await seedDummyNotifications();
    console.log(`[Seed] Seeded ${result ? result.length : 0} notices successfully!`);
    process.exit(0);
  } catch (err) {
    console.error('[Seed Error]:', err);
    process.exit(1);
  }
}

run();
