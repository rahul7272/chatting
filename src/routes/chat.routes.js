const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Media upload endpoints
router.post('/upload', authenticate, chatController.uploadFile);
router.post('/upload-multiple', authenticate, chatController.uploadMultipleFiles);

// Global message search across user's enrolled batches
router.get('/search', authenticate, chatController.searchMessages);

// Batch group messages & real-time actions
router.get('/:groupId/messages', authenticate, chatController.getMessages);
router.post('/:groupId/messages', authenticate, chatController.sendMessage);
router.delete('/:groupId/clear', authenticate, chatController.clearGroupChat);
router.get('/:groupId/pinned', authenticate, chatController.getPinnedMessages);
router.get('/:groupId/media', authenticate, chatController.getGroupMedia);
router.get('/:groupId/search', authenticate, chatController.searchMessages);
router.post('/:groupId/read', authenticate, chatController.markGroupMessagesAsRead);

// Message scheduling endpoints
router.post('/:groupId/schedule', authenticate, chatController.scheduleMessage);
router.get('/:groupId/scheduled', authenticate, chatController.getScheduledMessages);
router.delete('/scheduled/:id', authenticate, chatController.cancelScheduledMessage);
router.post('/scheduled/:id/cancel', authenticate, chatController.cancelScheduledMessage);

// Poll voting, voter inspection, and poll state management
router.post('/messages/:messageId/vote', authenticate, chatController.votePoll);
router.post('/messages/:messageId/close-poll', authenticate, chatController.togglePollStatus);
router.get('/messages/:messageId/poll-voters', authenticate, chatController.getPollVoters);

// Read receipts & seen-by tracking
router.post('/messages/:messageId/read', authenticate, chatController.markMessageAsRead);
router.get('/messages/:messageId/read-receipts', authenticate, chatController.getMessageReadReceipts);

// Message-level interactions & moderation
router.patch('/messages/:messageId', authenticate, chatController.editMessage);
router.delete('/messages/:messageId', authenticate, chatController.deleteMessage);
router.post('/messages/:messageId/react', authenticate, chatController.reactToMessage);
router.post('/messages/:messageId/pin', authenticate, chatController.pinMessage);
router.post('/messages/:messageId/forward', authenticate, chatController.forwardMessage);

module.exports = router;
