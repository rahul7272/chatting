const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Send announcements and notifications
router.post('/send', authenticate, notificationController.sendNotification);

// Admin listing
router.get('/', authenticate, notificationController.getNotifications);

// Batches list for notification composer
router.get('/batches', authenticate, notificationController.getBatchesForNotifications);

// Seed realistic dummy notices
router.post('/seed-dummy', authenticate, notificationController.seedDummyNotifications);

// Class alerts automated & test triggers
router.post('/trigger-class-alerts', authenticate, notificationController.triggerClassAlerts);
router.post('/test-alert/:groupId', authenticate, notificationController.triggerTestAlert);

// User-specific notifications (Students / Teachers)
router.get('/my', authenticate, notificationController.getMyNotifications);
router.post('/:id/read', authenticate, notificationController.markAsRead);
router.post('/device-token', notificationController.registerDeviceToken);
router.post('/send-single', notificationController.sendSinglePush);

// Management
router.delete('/:id', authenticate, notificationController.deleteNotification);

module.exports = router;
