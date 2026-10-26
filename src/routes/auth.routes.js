const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.post('/request-otp', authController.requestOtp);
router.post('/verify-otp', authController.verifyOtp);
router.post('/google', authController.googleAuth);
router.post('/refresh', authController.refreshToken);
router.get('/me', authenticate, authController.getMe);

module.exports = router;
