const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.post('/upload', authenticate, chatController.uploadFile);
router.get('/:groupId/messages', authenticate, chatController.getMessages);
router.post('/:groupId/messages', authenticate, chatController.sendMessage);
router.post('/:groupId/read', authenticate, chatController.markGroupMessagesAsRead);

// Poll voting & student voter details
router.post('/messages/:messageId/vote', authenticate, chatController.votePoll);
router.get('/messages/:messageId/poll-voters', authenticate, chatController.getPollVoters);

// Message read receipts & seen-by tracking
router.post('/messages/:messageId/read', authenticate, chatController.markMessageAsRead);
router.get('/messages/:messageId/read-receipts', authenticate, chatController.getMessageReadReceipts);

// Message operations
router.patch('/messages/:messageId', authenticate, chatController.editMessage);
router.delete('/messages/:messageId', authenticate, chatController.deleteMessage);
router.post('/messages/:messageId/react', authenticate, chatController.reactToMessage);
router.post('/messages/:messageId/pin', authenticate, chatController.pinMessage);

module.exports = router;
