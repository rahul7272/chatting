const express = require('express');
const router = express.Router();
const creditController = require('../controllers/credit.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

router.get('/my', authenticate, creditController.getStudentCredits);
router.get('/transactions', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), creditController.getAllTransactions);
router.get('/student/:studentId', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), creditController.getStudentCredits);
router.post('/adjust', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), creditController.adjustCredits);

module.exports = router;

