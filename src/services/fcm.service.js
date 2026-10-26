const { admin } = require('../config/firebase');
const logger = require('../utils/logger');
const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');

class FcmService {
  /**
   * Dispatch a notification to topics and device tokens
   */
  async dispatchNotification(notification) {
    try {
      const {
        title,
        message,
        type = 'ANNOUNCEMENT',
        priority = 'STANDARD',
        targetAudience = 'ALL',
        targetGroupIds = [],
        meetUrl = '',
        actionUrl = '',
        _id,
        excludeUserId,
        groupId,
        groupTitle,
        senderId,
        senderName,
      } = notification;

      const isChatMessage = type === 'CHAT_MESSAGE';
      const isHighPriority = !isChatMessage && (priority === 'HIGH' || priority === 'URGENT' || type === 'CLASS_ALERT_5M');
      const channelId = isHighPriority
        ? 'high_importance_channel'
        : (isChatMessage ? 'chat_messages_channel' : 'announcements_channel');

      const payloadData = {
        notificationId: (_id || '').toString(),
        type: type.toString(),
        priority: isChatMessage ? 'STANDARD' : priority.toString(),
        meetUrl: (meetUrl || '').toString(),
        actionUrl: (actionUrl || meetUrl || '').toString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        ...(groupId ? { groupId: groupId.toString() } : {}),
        ...(groupTitle ? { groupTitle: groupTitle.toString() } : {}),
        ...(senderId ? { senderId: senderId.toString() } : {}),
        ...(senderName ? { senderName: senderName.toString() } : {}),
      };

      // Construct Android-specific high-priority heads-up payload
      const messagePayload = {
        notification: {
          title: title.toString(),
          body: message.toString(),
        },
        data: payloadData,
        android: {
          priority: isHighPriority ? 'high' : 'normal',
          notification: {
            channelId: channelId,
            sound: 'default',
            priority: isHighPriority ? 'max' : 'high',
            visibility: 'public',
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            defaultVibrateTimings: true,
            defaultSound: true,
          },
        },
        apns: {
          headers: {
            'apns-priority': '10',
          },
          payload: {
            aps: {
              alert: {
                title: title.toString(),
                body: message.toString(),
              },
              sound: 'default',
              badge: 1,
              contentAvailable: true,
            },
          },
        },
      };

      // Determine Topics (Never broadcast chat messages to bulk topics where the sender cannot be excluded)
      const topics = [];
      if (!isChatMessage) {
        if (targetAudience === 'ALL') {
          topics.push('all');
        } else if (targetAudience === 'STUDENTS') {
          topics.push('students');
        } else if (targetAudience === 'TEACHERS') {
          topics.push('teachers');
        } else if (targetAudience === 'BATCH_GROUPS' && Array.isArray(targetGroupIds)) {
          targetGroupIds.forEach((gid) => {
            topics.push(`batch_${gid.toString()}`);
          });
        }
      }

      // 1. Send to FCM Topics
      for (const topic of topics) {
        try {
          if (admin.apps && admin.apps.length > 0) {
            await admin.messaging().send({
              ...messagePayload,
              topic: topic,
            });
            logger.info(`[FCM] Dispatched push to topic: ${topic}`);
          } else {
            logger.info(`[FCM Simulated] Broadcasted to topic: ${topic} - "${title}"`);
          }
        } catch (topicErr) {
          logger.warn(`[FCM Topic Warning] Could not send to topic ${topic}: ${topicErr.message}`);
        }
      }

      // 2. Collect Registered User Tokens if targeting specific users/batches
      let tokens = [];
      const excludeFilter = excludeUserId ? { _id: { $ne: excludeUserId } } : {};
      if (targetAudience === 'BATCH_GROUPS' && targetGroupIds.length > 0) {
        // Collect tokens from enrolled students and teachers in these batches (excluding sender)
        const [students, teachers] = await Promise.all([
          Student.find({ batchIds: { $in: targetGroupIds }, isActive: true, ...excludeFilter }).select('fcmTokens').lean(),
          Teacher.find({ assignedBatchIds: { $in: targetGroupIds }, isActive: true, ...excludeFilter }).select('fcmTokens').lean(),
        ]);
        students.forEach((s) => (s.fcmTokens || []).forEach((t) => t && tokens.push(t)));
        teachers.forEach((t) => (t.fcmTokens || []).forEach((tok) => tok && tokens.push(tok)));
      } else if (targetAudience === 'STUDENTS') {
        const students = await Student.find({ isActive: true, ...excludeFilter }).select('fcmTokens').lean();
        students.forEach((s) => (s.fcmTokens || []).forEach((t) => t && tokens.push(t)));
      } else if (targetAudience === 'TEACHERS') {
        const teachers = await Teacher.find({ isActive: true, ...excludeFilter }).select('fcmTokens').lean();
        teachers.forEach((t) => (t.fcmTokens || []).forEach((tok) => tok && tokens.push(tok)));
      } else {
        const users = await User.find({ isActive: true, ...excludeFilter }).select('fcmTokens').lean();
        users.forEach((u) => (u.fcmTokens || []).forEach((tok) => tok && tokens.push(tok)));
      }

      // Deduplicate tokens
      tokens = [...new Set(tokens)].filter((t) => typeof t === 'string' && t.length > 10);

      if (tokens.length > 0 && admin.apps && admin.apps.length > 0) {
        try {
          const response = await admin.messaging().sendEachForMulticast({
            tokens: tokens,
            ...messagePayload,
          });
          logger.info(`[FCM Multicast] Sent to ${response.successCount} of ${tokens.length} devices.`);
        } catch (multicastErr) {
          logger.warn(`[FCM Multicast Warning]: ${multicastErr.message}`);
        }
      }
    } catch (err) {
      logger.error(`[FCM Dispatch Error]: ${err.message}`);
    }
  }

  /**
   * Save device token and subscribe to default topics
   */
  async registerToken(userId, role, token) {
    if (!token || typeof token !== 'string') return;

    try {
      if (userId) {
        await User.findByIdAndUpdate(userId, { $addToSet: { fcmTokens: token } }).catch(() => {});
        await Student.findByIdAndUpdate(userId, { $addToSet: { fcmTokens: token } }).catch(() => {});
        await Teacher.findByIdAndUpdate(userId, { $addToSet: { fcmTokens: token } }).catch(() => {});
      }

      // Subscribe token to topics if Firebase is active
      if (admin.apps && admin.apps.length > 0) {
        await admin.messaging().subscribeToTopic([token], 'all').catch(() => {});
        if (role === 'STUDENT') {
          await admin.messaging().subscribeToTopic([token], 'students').catch(() => {});
        } else if (role === 'TEACHER') {
          await admin.messaging().subscribeToTopic([token], 'teachers').catch(() => {});
        }
        logger.info(`[FCM] Device token registered and subscribed to topics for user: ${userId || 'anonymous'}`);
      }
    } catch (e) {
      logger.warn(`[FCM Token Registration Warning]: ${e.message}`);
    }
  }

  /**
   * Send Chat Message Push Notification
   */
  async sendChatMessageNotification({ message, group, senderId }) {
    try {
      if (!message) return;
      const actualSenderId = senderId || message.senderId?._id || message.senderId;
      const senderName = message.senderName || message.senderId?.name || 'New Message';
      const groupId = group?._id || message.groupId;
      const groupTitle = group?.title || group?.name || '';

      let previewText = message.text || '';
      if (message.type === 'VOICE') previewText = '🎤 Voice message';
      else if (message.type === 'IMAGE') previewText = '📷 Photo';
      else if (message.type === 'DOCUMENT') previewText = '📎 Document';
      else if (message.type === 'POLL') previewText = `📊 Poll: ${message.pollData?.question || 'New Poll'}`;

      const title = groupTitle ? `${senderName} (${groupTitle})` : senderName;
      const body = previewText || 'Sent an attachment';

      const payload = {
        title,
        message: body,
        type: 'CHAT_MESSAGE',
        priority: 'STANDARD',
        targetAudience: 'BATCH_GROUPS',
        targetGroupIds: groupId ? [groupId] : [],
        actionUrl: `/chat/${groupId}`,
        _id: message._id,
        groupId: groupId ? groupId.toString() : '',
        groupTitle: groupTitle,
        senderId: actualSenderId ? actualSenderId.toString() : '',
        senderName: senderName,
        excludeUserId: actualSenderId ? actualSenderId.toString() : null,
      };

      await this.dispatchNotification(payload);
    } catch (err) {
      logger.warn(`[FCM Chat Push Warning]: ${err.message}`);
    }
  }

  /**
   * Send Attendance Notification to student
   */
  async sendAttendanceNotification({ studentId, status, batchTitle, classDate }) {
    try {
      if (!studentId) return;
      const title = '📋 Attendance Updated';
      const body = `Your attendance has been marked as ${status} for ${batchTitle || 'your class'}.`;

      const student = (await Student.findById(studentId).select('fcmTokens').lean()) ||
        (await User.findById(studentId).select('fcmTokens').lean());

      const tokens = (student?.fcmTokens || []).filter((t) => typeof t === 'string' && t.length > 10);

      if (tokens.length > 0 && admin.apps && admin.apps.length > 0) {
        await admin.messaging().sendEachForMulticast({
          tokens,
          notification: { title, body },
          data: {
            screen: 'attendance',
            studentId: studentId.toString(),
            status: status.toString(),
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'announcements_channel',
              sound: 'default',
            },
          },
          apns: {
            headers: {
              'apns-priority': '10',
            },
            payload: {
              aps: {
                alert: { title, body },
                sound: 'default',
                badge: 1,
                contentAvailable: true,
              },
            },
          },
        });
        logger.info(`[FCM Attendance Push] Sent to student ${studentId}`);
      } else {
        logger.info(`[FCM Attendance Simulated] Sent to student ${studentId}: "${title} - ${body}"`);
      }
    } catch (err) {
      logger.warn(`[FCM Attendance Push Warning]: ${err.message}`);
    }
  }

  /**
   * Direct push to single token or user
   */
  async sendSinglePush({ token, userId, title, body, data = {} }) {
    let tokens = [];
    if (token) tokens.push(token);
    if (userId) {
      const u = (await User.findById(userId).select('fcmTokens').lean()) ||
        (await Student.findById(userId).select('fcmTokens').lean()) ||
        (await Teacher.findById(userId).select('fcmTokens').lean());
      if (u && u.fcmTokens) tokens.push(...u.fcmTokens);
    }
    tokens = [...new Set(tokens)].filter((t) => typeof t === 'string' && t.length > 10);

    const messagePayload = {
      notification: { title, body },
      data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      android: {
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel',
          sound: 'default',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            badge: 1,
            contentAvailable: true,
          },
        },
      },
    };

    if (tokens.length > 0 && admin.apps && admin.apps.length > 0) {
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        ...messagePayload,
      });
      return { success: true, sentCount: res.successCount, totalTokens: tokens.length };
    } else {
      logger.info(`[FCM Single Push Simulated] "${title}": "${body}"`);
      return { success: true, simulated: true, totalTokens: tokens.length };
    }
  }
}

module.exports = new FcmService();
