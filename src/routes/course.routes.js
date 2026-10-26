const express = require('express');
const router = express.Router();
const courseController = require('../controllers/course.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

// List courses (Public/authenticated for forms and selection)
router.get('/', courseController.listCourses);

// Admin-managed routes
router.post('/', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), courseController.createCourse);
router.patch('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), courseController.updateCourse);
router.put('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), courseController.updateCourse);
router.delete('/:id', authenticate, authorize([ROLES.ADMIN]), courseController.deleteCourse);

module.exports = router;
