const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const Group = require('../models/Group');
const Message = require('../models/Message');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const { broadcast } = require('../config/socket');
const socketEvents = require('../constants/socketEvents');
const fcmService = require('../services/fcm.service');

/**
 * Send an Announcement / Notification
 * Can target: ALL, STUDENTS, TEACHERS, or specific BATCH_GROUPS
 */
const sendNotification = async (req, res, next) => {
  try {
    const {
      title,
      message,
      type = 'ANNOUNCEMENT',
      priority = 'STANDARD',
      targetAudience = 'ALL',
      targetGroupIds = [],
      actionUrl = '',
      meetUrl = '',
    } = req.body;

    if (!title || !title.trim() || !message || !message.trim()) {
      return errorResponse(res, 'Title and message are required.', statusCodes.BAD_REQUEST);
    }

    const senderName = req.user?.name || 'Academy Administrator';

    // Validate and fetch target groups if target is BATCH_GROUPS
    let resolvedGroupTitles = [];
    let validGroupIds = [];
    let recipientCount = 0;

    if (targetAudience === 'BATCH_GROUPS' && Array.isArray(targetGroupIds) && targetGroupIds.length > 0) {
      validGroupIds = targetGroupIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
      const groups = await Group.find({ _id: { $in: validGroupIds } }).lean();
      resolvedGroupTitles = groups.map((g) => g.title);

      // Calculate total unique recipients
      const memberSet = new Set();
      groups.forEach((g) => {
        (g.studentIds || []).forEach((s) => memberSet.add(s.toString()));
        (g.teacherIds || []).forEach((t) => memberSet.add(t.toString()));
        (g.members || []).forEach((m) => memberSet.add((m.userId || m._id || m).toString()));
      });
      recipientCount = memberSet.size;
    } else if (targetAudience === 'STUDENTS') {
      recipientCount = await Student.countDocuments({ isActive: true });
    } else if (targetAudience === 'TEACHERS') {
      recipientCount = await Teacher.countDocuments({ isActive: true });
    } else {
      const [sCount, tCount] = await Promise.all([
        Student.countDocuments({ isActive: true }),
        Teacher.countDocuments({ isActive: true }),
      ]);
      recipientCount = sCount + tCount;
    }

    // Create Notification document
    const notification = await Notification.create({
      title: title.trim(),
      message: message.trim(),
      type,
      priority,
      targetAudience,
      targetGroupIds: validGroupIds,
      targetGroupTitles: resolvedGroupTitles,
      actionUrl: actionUrl.trim(),
      meetUrl: meetUrl.trim(),
      sentBy: senderName,
      sentAt: new Date(),
      recipientsCount: recipientCount,
      metadata: {
        platformNote: 'Native Android/iOS Heads-up & Push Dispatch with sound/vibration headers',
      },
    });

    // If target is specific batch groups, inject announcement into each group and post a system message in chat
    if (validGroupIds.length > 0) {
      for (const gId of validGroupIds) {
        try {
          await Group.findByIdAndUpdate(gId, {
            $push: {
              announcements: {
                $each: [
                  {
                    title: title.trim(),
                    message: message.trim(),
                    target: 'ALL',
                    sentAt: new Date(),
                    sentBy: senderName,
                  },
                ],
                $position: 0,
              },
              activityLogs: {
                $each: [
                  {
                    action: 'Batch Notification Sent',
                    actorName: senderName,
                    details: `Notice: "${title.trim()}". Priority: ${priority}`,
                    timestamp: new Date(),
                  },
                ],
                $position: 0,
              },
            },
          });

          // Post a system chat message so members inside chat also see the notice
          const systemMsg = await Message.create({
            groupId: gId,
            senderName: senderName,
            text: `📢 [${priority === 'HIGH' ? 'URGENT NOTICE' : 'ANNOUNCEMENT'}]: ${title.trim()}\n${message.trim()}${meetUrl ? `\n🔗 Class Link: ${meetUrl}` : ''}`,
            type: 'SYSTEM',
            metadata: {
              notificationId: notification._id,
              isAnnouncement: true,
              priority,
              actionUrl: actionUrl || meetUrl,
            },
          });

          broadcast(socketEvents.NEW_MESSAGE, systemMsg, gId.toString());
          broadcast(socketEvents.GROUP_UPDATED, { groupId: gId }, gId.toString());
        } catch (groupErr) {
          console.warn('[Error pushing announcement to group]:', groupErr.message);
        }
      }
    }

    // Universal Real-Time Broadcast across Native WebSocket and Socket.IO
    try {
      if (validGroupIds.length > 0) {
        validGroupIds.forEach((gid) => {
          broadcast('new_notification', notification, gid.toString());
        });
      } else {
        broadcast('new_notification', notification);
      }
    } catch (e) {
      console.warn('[Broadcast Error in sendNotification]:', e.message);
    }

    // Native Mobile Push Dispatch (FCM)
    fcmService.dispatchNotification(notification).catch((fcmErr) => {
      console.warn('[FCM Background Dispatch Warning]:', fcmErr.message);
    });

    return successResponse(
      res,
      { notification },
      `Notification broadcast successfully to ${recipientCount} recipients.`,
      statusCodes.CREATED
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Get all notifications (Admin view)
 */
const getNotifications = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search = '', type = '' } = req.query;
    const query = {};

    if (type) {
      query.type = type;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } },
        { sentBy: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    let [notifications, total] = await Promise.all([
      Notification.find(query).sort({ sentAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Notification.countDocuments(query),
    ]);

    // Auto-seed dummy notices if database has none
    if (total === 0 && !search && !type) {
      await seedDummyNotifications();
      [notifications, total] = await Promise.all([
        Notification.find(query).sort({ sentAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        Notification.countDocuments(query),
      ]);
    }

    return successResponse(res, {
      notifications,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get notifications for the logged in user (Students / Teachers)
 */
const getMyNotifications = async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    const userRole = (req.user?.role || req.query.role || 'STUDENT').toUpperCase();

    // Find groups user is part of
    let userGroupIds = [];
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      const groups = await Group.find({
        $or: [
          { studentIds: userId },
          { teacherIds: userId },
          { 'members.userId': userId },
        ],
      })
        .select('_id')
        .lean();
      userGroupIds = groups.map((g) => g._id);
    }

    // Build audience filter
    const audienceFilters = [{ targetAudience: 'ALL' }];
    if (userRole === 'STUDENT') {
      audienceFilters.push({ targetAudience: 'STUDENTS' });
    } else if (userRole === 'TEACHER') {
      audienceFilters.push({ targetAudience: 'TEACHERS' });
    }

    if (userGroupIds.length > 0) {
      audienceFilters.push({
        targetAudience: 'BATCH_GROUPS',
        targetGroupIds: { $in: userGroupIds },
      });
    }

    let notifications = await Notification.find({ $or: audienceFilters })
      .sort({ sentAt: -1 })
      .limit(60)
      .lean();

    // Auto-seed if database is completely empty
    if (notifications.length === 0) {
      const totalCount = await Notification.countDocuments();
      if (totalCount === 0) {
        await seedDummyNotifications();
        notifications = await Notification.find({ $or: audienceFilters })
          .sort({ sentAt: -1 })
          .limit(60)
          .lean();
      }
    }

    return successResponse(res, { notifications });
  } catch (err) {
    next(err);
  }
};

/**
 * Mark a notification as read (with safe ObjectId validation)
 */
const markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.body.userId || 'dev_user';

    if (!id) {
      return errorResponse(res, 'Notification ID is required.', statusCodes.BAD_REQUEST);
    }

    // If ID is not a MongoDB ObjectId (e.g. static/local dummy notice), acknowledge gracefully
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return successResponse(res, { id, status: 'acknowledged' }, 'Notification acknowledged.');
    }

    const updated = await Notification.findByIdAndUpdate(
      id,
      { $addToSet: { readBy: userId.toString() } },
      { new: true }
    );

    if (!updated) {
      return successResponse(res, { id, status: 'acknowledged' }, 'Notification acknowledged.');
    }

    return successResponse(res, { notification: updated }, 'Notification marked as read.');
  } catch (err) {
    next(err);
  }
};

/**
 * Delete a notification (with safe ObjectId validation)
 */
const deleteNotification = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 'Invalid notification ID.', statusCodes.BAD_REQUEST);
    }
    const deleted = await Notification.findByIdAndDelete(id);
    if (!deleted) {
      return errorResponse(res, 'Notification not found.', statusCodes.NOT_FOUND);
    }
    return successResponse(res, { id }, 'Notification deleted successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Seed realistic dummy notices into MongoDB
 */
const seedDummyNotifications = async (req, res, next) => {
  try {
    const activeBatches = await Group.find({ status: { $ne: 'Archived' } }).limit(4).lean();
    const batch1 = activeBatches[0];
    const batch2 = activeBatches[1];

    const dummyNotices = [
      {
        title: '⚡ Important: Annual Classical Sangeet Examination Schedule',
        message: 'The annual classical music theory & practical assessments will commence from next Monday. Please download your hall tickets and verify assigned batch slots.',
        type: 'ANNOUNCEMENT',
        priority: 'HIGH',
        targetAudience: 'STUDENTS',
        targetGroupIds: [],
        targetGroupTitles: [],
        sentBy: 'Academic Dean Office',
        sentAt: new Date(Date.now() - 1000 * 60 * 30), // 30 mins ago
        recipientsCount: 248,
        readBy: [],
        metadata: { category: 'EXAMS' },
      },
      {
        title: '🔔 Class Reminder: Daily Vocal Riyaaz session in 15 mins',
        message: batch1
          ? `Your live music session for ${batch1.title} is starting in 15 minutes. Ensure your instrument or Tanpura is tuned.`
          : 'Your daily morning vocal riyaaz session begins in 15 minutes. Please tune your Tanpura instruments and join the Meet room.',
        type: 'CLASS_REMINDER_15M',
        priority: 'STANDARD',
        targetAudience: batch1 ? 'BATCH_GROUPS' : 'STUDENTS',
        targetGroupIds: batch1 ? [batch1._id] : [],
        targetGroupTitles: batch1 ? [batch1.title] : [],
        classId: batch1 ? batch1._id : null,
        classTitle: batch1 ? batch1.title : 'Classical Vocal (Advanced)',
        meetUrl: batch1?.meetLink || 'https://meet.google.com/live-vocal-class',
        actionUrl: batch1?.meetLink || 'https://meet.google.com/live-vocal-class',
        sentBy: 'Automated Class Dispatcher',
        sentAt: new Date(Date.now() - 1000 * 60 * 15), // 15 mins ago
        recipientsCount: batch1?.studentIds?.length || 18,
        readBy: [],
        metadata: { alertWindow: 'T-15m' },
      },
      {
        title: '⚡ Urgent Class Alert: Live Session starts in 5 minutes!',
        message: batch2
          ? `High-priority class alert for ${batch2.title}. The maestro has joined the room. Tap "Join Now" to enter the classroom.`
          : 'High-priority class alert: Hindustani Classical Advanced session starts in 5 minutes. Tap "Join Now" to enter.',
        type: 'CLASS_ALERT_5M',
        priority: 'HIGH',
        targetAudience: batch2 ? 'BATCH_GROUPS' : 'STUDENTS',
        targetGroupIds: batch2 ? [batch2._id] : [],
        targetGroupTitles: batch2 ? [batch2.title] : [],
        classId: batch2 ? batch2._id : null,
        classTitle: batch2 ? batch2.title : 'Hindustani Classical Advanced',
        meetUrl: batch2?.meetLink || 'https://meet.google.com/live-advanced-class',
        actionUrl: batch2?.meetLink || 'https://meet.google.com/live-advanced-class',
        sentBy: 'Automated Class Dispatcher',
        sentAt: new Date(Date.now() - 1000 * 60 * 5), // 5 mins ago
        recipientsCount: batch2?.studentIds?.length || 24,
        readBy: [],
        metadata: { alertWindow: 'T-5m', highPriorityNotification: true },
      },
      {
        title: '📋 Faculty Notice: Monthly Student Attendance & Practice Review',
        message: 'All teaching faculty are requested to verify student riyaaz attendance and submit credit endorsements for the upcoming evaluation week.',
        type: 'ANNOUNCEMENT',
        priority: 'STANDARD',
        targetAudience: 'TEACHERS',
        targetGroupIds: [],
        targetGroupTitles: [],
        sentBy: 'Head of Academics',
        sentAt: new Date(Date.now() - 1000 * 60 * 60 * 4), // 4 hours ago
        recipientsCount: 42,
        readBy: [],
        metadata: { category: 'FACULTY' },
      },
      {
        title: '🎉 Sangeet Mahotsav 2026: Annual Gurukul Cultural Festival',
        message: 'We are thrilled to announce Sangeet Mahotsav 2026! Masterclass recitals by guest Maestros and solo student performances scheduled for this weekend. Entry passes available at the academic desk.',
        type: 'ANNOUNCEMENT',
        priority: 'STANDARD',
        targetAudience: 'ALL',
        targetGroupIds: [],
        targetGroupTitles: [],
        actionUrl: '/groups',
        sentBy: 'Academy Administrator',
        sentAt: new Date(Date.now() - 1000 * 60 * 60 * 24), // 1 day ago
        recipientsCount: 290,
        readBy: [],
        metadata: { category: 'GENERAL' },
      },
    ];

    const inserted = await Notification.insertMany(dummyNotices);

    if (res) {
      return successResponse(
        res,
        { notifications: inserted, count: inserted.length },
        `Successfully seeded ${inserted.length} realistic dummy notices.`,
        statusCodes.CREATED
      );
    }
    return inserted;
  } catch (err) {
    if (next) return next(err);
    console.error('[Error seeding dummy notifications]:', err.message);
  }
};

/**
 * Helper to parse schedule time e.g. "05:00 PM - 06:00 PM" into minutes from midnight
 */
const parseTimeToMinutes = (timeStr) => {
  if (!timeStr) return null;
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = (match[3] || '').toUpperCase();

  if (period === 'PM' && hours < 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;

  return hours * 60 + minutes;
};

/**
 * Trigger Class Alert (T-15m and T-5m)
 * Automatically called via interval or triggered manually by Admin
 */
const triggerClassAlerts = async (req, res, next) => {
  try {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // Map day of week (0=Sun, 1=Mon, ..., 6=Sat)
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentDayName = dayNames[now.getDay()];

    const activeGroups = await Group.find({
      status: 'Active',
      isActive: true,
    }).lean();

    const dispatchedAlerts = [];

    const forceAll = Boolean(req?.body?.forceAll);
    const testType = req?.body?.testType;

    for (const group of activeGroups) {
      const schedule = group.schedule || {};
      const days = schedule.days || [];
      const startTimeStr = schedule.startTime || '';

      // Check if group meets today
      const meetsToday = days.some((d) => d.toLowerCase().includes(currentDayName.toLowerCase()));
      if (!meetsToday && !forceAll) continue;

      const classMinutes = parseTimeToMinutes(startTimeStr);
      if (classMinutes === null && !forceAll) continue;

      const diffMinutes = classMinutes !== null ? classMinutes - currentMinutes : 15;

      // T-15 Minutes: Standard Reminder (11 to 17 minutes before class)
      const isT15 = (diffMinutes >= 11 && diffMinutes <= 18) || testType === 'T-15';

      // T-5 Minutes: High-Priority Urgent Alert (2 to 7 minutes before class)
      const isT5 = (diffMinutes >= 2 && diffMinutes <= 7) || testType === 'T-5';

      if (isT15 || isT5) {
        const alertType = isT5 ? 'CLASS_ALERT_5M' : 'CLASS_REMINDER_15M';
        const priority = isT5 ? 'HIGH' : 'STANDARD';
        const title = isT5
          ? `⚡ Urgent Class Alert: ${group.title} starts in 5 minutes!`
          : `🔔 Class Reminder: ${group.title} begins in 15 minutes`;

        const meetLink = group.meetLink || group.googleMeet?.meetUrl || '';
        const message = isT5
          ? `Your live music session is starting right now. Tap "Join Now" to enter the classroom.`
          : `Get your instruments ready. Class is scheduled for ${startTimeStr || 'soon'}.${meetLink ? ` Meet link is ready.` : ''}`;

        const notification = await Notification.create({
          title,
          message,
          type: alertType,
          priority,
          targetAudience: 'BATCH_GROUPS',
          targetGroupIds: [group._id],
          targetGroupTitles: [group.title],
          classId: group._id,
          classTitle: group.title,
          meetUrl: meetLink,
          actionUrl: meetLink || `/groups/${group._id}`,
          sentBy: 'Automated Class Dispatcher',
          sentAt: new Date(),
          recipientsCount: (group.studentIds?.length || 0) + (group.teacherIds?.length || 0),
          metadata: {
            alertWindow: isT5 ? 'T-5m' : 'T-15m',
            highPriorityNotification: isT5,
            ringtoneAlert: isT5,
          },
        });

        // Broadcast over WebSockets
        try {
          broadcast('new_notification', notification, group._id.toString());
          broadcast('class_started', {
            groupId: group._id,
            title: group.title,
            meetUrl: meetLink,
            alertType,
          }, group._id.toString());
        } catch (e) {
          console.warn('[Broadcast Error]:', e.message);
        }

        // Native Mobile Push Dispatch (FCM)
        fcmService.dispatchNotification(notification).catch((fcmErr) => {
          console.warn('[FCM Class Alert Dispatch Warning]:', fcmErr.message);
        });

        dispatchedAlerts.push({
          groupId: group._id,
          batchTitle: group.title,
          alertType,
          priority,
        });
      }
    }

    if (res) {
      return successResponse(
        res,
        { dispatchedAlerts, count: dispatchedAlerts.length },
        `Checked ${activeGroups.length} batches. Dispatched ${dispatchedAlerts.length} class alerts.`
      );
    }
  } catch (err) {
    if (next) return next(err);
    console.error('[Error in triggerClassAlerts]:', err.message);
  }
};

/**
 * Test Fire a T-15m or T-5m class alert for a specific batch on demand
 */
const triggerTestAlert = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { alertType = 'T-5' } = req.body; // 'T-15' or 'T-5'

    const group = await Group.findById(groupId).lean();
    if (!group) {
      return errorResponse(res, 'Batch group not found.', statusCodes.NOT_FOUND);
    }

    const isT5 = alertType === 'T-5';
    const typeEnum = isT5 ? 'CLASS_ALERT_5M' : 'CLASS_REMINDER_15M';
    const priority = isT5 ? 'HIGH' : 'STANDARD';
    const meetLink = group.meetLink || group.googleMeet?.meetUrl || 'https://meet.google.com/live-class';

    const title = isT5
      ? `⚡ [TEST] High-Priority Class Alert: ${group.title} in 5 mins!`
      : `🔔 [TEST] Class Reminder: ${group.title} in 15 mins`;

    const message = isT5
      ? `High-priority test alert sent by Admin. Tap "Join Now" to test joining classroom.`
      : `Standard class reminder test sent by Admin for ${group.title}.`;

    const notification = await Notification.create({
      title,
      message,
      type: typeEnum,
      priority,
      targetAudience: 'BATCH_GROUPS',
      targetGroupIds: [group._id],
      targetGroupTitles: [group.title],
      classId: group._id,
      classTitle: group.title,
      meetUrl: meetLink,
      actionUrl: meetLink,
      sentBy: req.user?.name || 'Admin Console',
      sentAt: new Date(),
      recipientsCount: (group.studentIds?.length || 0) + (group.teacherIds?.length || 0),
      metadata: {
        isTest: true,
        alertWindow: isT5 ? 'T-5m' : 'T-15m',
      },
    });

    // Broadcast over WebSocket to all clients in group
    try {
      broadcast('new_notification', notification, group._id.toString());
      broadcast('new_notification', notification); // Also universal for test
    } catch (e) {
      console.warn('[Broadcast Error in triggerTestAlert]:', e.message);
    }

    // Native Mobile Push Dispatch (FCM)
    fcmService.dispatchNotification(notification).catch((fcmErr) => {
      console.warn('[FCM Test Alert Dispatch Warning]:', fcmErr.message);
    });

    return successResponse(
      res,
      { notification },
      `Test ${isT5 ? 'T-5 Minute High-Priority Alert' : 'T-15 Minute Reminder'} triggered successfully.`
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Register mobile device FCM token for push notifications
 */
const registerDeviceToken = async (req, res, next) => {
  try {
    const { token, role } = req.body;
    const userId = req.user?.userId || req.body.userId;

    if (!token) {
      return errorResponse(res, 'FCM device token is required.', statusCodes.BAD_REQUEST);
    }

    await fcmService.registerToken(userId, role || req.user?.role, token);
    return successResponse(res, { status: 'registered' }, 'FCM device token registered successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Get active batches helper for the Notification Composer dropdown
 */
const getBatchesForNotifications = async (req, res, next) => {
  try {
    const groups = await Group.find({ status: { $ne: 'Archived' } })
      .select('title code status schedule meetLink googleMeet studentIds teacherIds')
      .lean();

    const formatted = groups.map((g) => ({
      id: g._id,
      _id: g._id,
      title: g.title,
      code: g.code,
      status: g.status,
      schedule: g.schedule,
      meetUrl: g.meetLink || g.googleMeet?.meetUrl || '',
      studentCount: g.studentIds?.length || 0,
      teacherCount: g.teacherIds?.length || 0,
    }));

    return successResponse(res, { batches: formatted });
  } catch (err) {
    next(err);
  }
};

/**
 * Direct push endpoint for testing FCM
 * POST /api/v1/notifications/send-single
 */
const sendSinglePush = async (req, res, next) => {
  try {
    const { token, userId, title = 'Academy Alert', body = 'Push notification test from backend', data = {} } = req.body;
    const result = await fcmService.sendSinglePush({ token, userId, title, body, data });
    return successResponse(res, result, 'Push notification dispatched via FCM.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  sendNotification,
  getNotifications,
  getMyNotifications,
  markAsRead,
  deleteNotification,
  triggerClassAlerts,
  triggerTestAlert,
  getBatchesForNotifications,
  seedDummyNotifications,
  registerDeviceToken,
  sendSinglePush,
};
