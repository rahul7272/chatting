const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

router.get('/', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), userController.listUsers);
router.post('/', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), userController.createUser);

// Authenticated user self profile endpoints
router.get('/profile/me', authenticate, userController.getMyProfile);
router.patch('/profile/me', authenticate, userController.updateProfile);

router.get('/:id', authenticate, userController.getUserById);
router.patch('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), userController.updateUser);
router.put('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), userController.updateUser);
router.delete('/:id', authenticate, authorize([ROLES.ADMIN]), userController.deleteUser);


module.exports = router;
