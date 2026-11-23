const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const groupRoutes = require('./group.routes');
const chatRoutes = require('./chat.routes');
const attendanceRoutes = require('./attendance.routes');
const creditRoutes = require('./credit.routes');
const teacherRoutes = require('./teacher.routes');
const courseRoutes = require('./course.routes');
const locationRoutes = require('./location.routes');
const adminRoutes = require('./admin.routes');
const notificationRoutes = require('./notification.routes');
const uploadRoutes = require('./upload.routes');
const appRoutes = require('./app.routes');
const syncRoutes = require('./sync.routes');
const payoutRoutes = require('./payout.routes');

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/students', userRoutes);
router.use('/teachers', teacherRoutes);
router.use('/courses', courseRoutes);
router.use('/locations', locationRoutes);
router.use('/groups', groupRoutes);
router.use('/chat', chatRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/credits', creditRoutes);
router.use('/payouts', payoutRoutes);
router.use('/admin', adminRoutes);
router.use('/notifications', notificationRoutes);
router.use('/upload', uploadRoutes);
router.use('/app', appRoutes);
router.use('/sync', syncRoutes);

module.exports = router;
