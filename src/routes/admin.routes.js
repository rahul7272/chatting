const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

router.get('/dashboard-stats', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), adminController.getDashboardStats);
router.get('/audit-logs', authenticate, authorize([ROLES.ADMIN]), adminController.getAuditLogs);

module.exports = router;
