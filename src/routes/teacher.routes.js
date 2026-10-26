const express = require('express');
const router = express.Router();
const teacherController = require('../controllers/teacher.controller');
const groupController = require('../controllers/group.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

// Upload avatar endpoint (standalone and by ID)
router.post('/upload-avatar', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), teacherController.uploadTeacherAvatar);
router.post('/:id/upload-avatar', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), teacherController.uploadTeacherAvatar);

// Teacher schedules hub
router.get('/schedules', authenticate, groupController.getGroupSchedules);

router.get('/', authenticate, teacherController.listTeachers);
router.get('/:id', authenticate, teacherController.getTeacherById);
router.post('/', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), teacherController.createTeacher);
router.patch('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), teacherController.updateTeacher);
router.put('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), teacherController.updateTeacher);
router.delete('/:id', authenticate, authorize([ROLES.ADMIN]), teacherController.deleteTeacher);

module.exports = router;
