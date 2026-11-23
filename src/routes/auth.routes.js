const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rate_limit.middleware');

router.post('/request-otp', authLimiter, authController.requestOtp);
router.post('/verify-otp', authLimiter, authController.verifyOtp);
router.post('/google', authLimiter, authController.googleAuth);
router.post('/refresh', authController.refreshToken);
router.get('/me', authenticate, authController.getMe);

module.exports = router;
