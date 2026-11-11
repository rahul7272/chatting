const express = require('express');
const router = express.Router();
const groupController = require('../controllers/group.controller');
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

// List, Schedules, and Dashboard Stats
router.get('/stats', authenticate, groupController.getGroupStats);
router.get('/schedules', authenticate, groupController.getGroupSchedules);
router.get('/', authenticate, groupController.listGroups);
router.post('/upload-avatar', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), chatController.uploadFile);
router.post('/', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.createGroup);

// Bulk Operations
router.post('/bulk', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.bulkUpdateGroups);

// Specific Group Operations
router.get('/:id', authenticate, groupController.getGroupById);
router.patch('/:id/schedule', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.updateGroupSchedule);
router.patch('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.updateGroup);
router.delete('/:id', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.deleteOrArchiveGroup);

// Teacher Assignment & Reassignment (Supports Single & Multi-Teacher)
router.post('/:id/assign-teacher', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.assignTeacher);
router.post('/:id/teachers', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.addTeachers);
router.delete('/:id/teachers/:teacherId', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.removeTeacher);

// Student Membership
router.post('/:id/students', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.addStudents);
router.delete('/:id/students/:studentId', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.removeStudent);

// Class Recordings
router.post('/:id/recordings', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEACHER]), groupController.addRecording);
router.delete('/:id/recordings/:recordingId', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEACHER]), groupController.deleteRecording);
router.post('/:id/recordings/:recordingId/watch', authenticate, groupController.logRecordingWatch);

// Notes & Assignments Resources
router.post('/:id/resources', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEACHER]), groupController.addResource);
router.patch('/:id/resources/:resourceId', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEACHER]), groupController.updateResource);
router.delete('/:id/resources/:resourceId', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEACHER]), groupController.deleteResource);

// Group Announcements
router.post('/:id/announcements', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), groupController.sendAnnouncement);

module.exports = router;

