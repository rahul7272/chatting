const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendance.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

// 1. Mark or Update Attendance (Teacher restricted to last 1 day; Admin unrestricted)
router.post('/mark', authenticate, authorize([ROLES.TEACHER, ROLES.ADMIN, ROLES.MANAGER]), attendanceController.markAttendance);

// 2. Student: View own attendance records and progress metrics
router.get('/my-attendance', authenticate, attendanceController.getMyAttendance);

// 3. Admin: Overview across all batches, metrics & filters
router.get('/admin/overview', authenticate, authorize([ROLES.ADMIN, ROLES.MANAGER]), attendanceController.getAdminOverview);

// 4. Group specific attendance history / daily attendance
router.get('/group/:groupId', authenticate, attendanceController.getGroupAttendance);

// 5. Teacher: View list of already marked attendance sessions for assigned classes
router.get('/teacher/history', authenticate, authorize([ROLES.TEACHER, ROLES.ADMIN, ROLES.MANAGER]), attendanceController.getTeacherHistory);

module.exports = router;
