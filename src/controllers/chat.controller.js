const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const Group = require('../models/Group');
const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const { broadcast } = require('../config/socket');
const socketEvents = require('../constants/socketEvents');
const fcmService = require('../services/fcm.service');

/**
 * Resolves user details from Student, Teacher, and User models
 */
const resolveUserDetails = async (userId, fallbackName = '', fallbackAvatar = '', fallbackRole = '') => {
  let name = fallbackName || '';
  let avatarUrl = fallbackAvatar || '';
  let role = fallbackRole || 'STUDENT';
  let enrollmentNo = '';
  let studentLevel = '';

  const idStr = (userId || '').toString().trim();
  if (idStr && mongoose.Types.ObjectId.isValid(idStr)) {
    try {
      const [student, teacher, user] = await Promise.all([
        Student.findById(idStr).select('name avatar avatarUrl role enrollmentNo studentLevel').lean().catch(() => null),
        Teacher.findById(idStr).select('name avatar avatarUrl role instruments').lean().catch(() => null),
        User.findById(idStr).select('name avatar avatarUrl role studentLevel').lean().catch(() => null),
      ]);

      const found = student || teacher || user;
      if (found) {
        name = found.name || name;
        avatarUrl = found.avatarUrl || found.avatar || avatarUrl;
        role = (found.role || (teacher ? 'TEACHER' : 'STUDENT')).toUpperCase();
        enrollmentNo = student?.enrollmentNo || '';
        studentLevel = student?.studentLevel || user?.studentLevel || '';
      }
    } catch (_) { }
  } else if (name) {
    try {
      const [student, teacher] = await Promise.all([
        Student.findOne({ name: new RegExp(`^${name}$`, 'i') }).select('name avatar avatarUrl role enrollmentNo studentLevel').lean().catch(() => null),
        Teacher.findOne({ name: new RegExp(`^${name}$`, 'i') }).select('name avatar avatarUrl role').lean().catch(() => null),
      ]);
      const found = student || teacher;
      if (found) {
        avatarUrl = found.avatarUrl || found.avatar || avatarUrl;
        role = (found.role || (teacher ? 'TEACHER' : 'STUDENT')).toUpperCase();
        enrollmentNo = student?.enrollmentNo || '';
        studentLevel = student?.studentLevel || '';
      }
    } catch (_) { }
  }

  return {
    userId: idStr,
    name: name || (role === 'TEACHER' ? 'Teacher' : 'Student'),
    avatarUrl,
    role: role.toUpperCase(),
    enrollmentNo,
    studentLevel,
  };
};

const getMessages = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { page = 1, limit = 100 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const rawMessages = await Message.find({ groupId })
      .populate('senderId', 'name avatarUrl role email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    // Resolve up-to-date sender, voter, and reader avatars and details
    const senderNames = [...new Set(rawMessages.map((m) => m.senderName).filter(Boolean))];
    const relatedIds = new Set();

    rawMessages.forEach((m) => {
      const sId = m.senderId?._id || m.senderId;
      if (sId && mongoose.Types.ObjectId.isValid(sId.toString())) relatedIds.add(sId.toString());

      // Collect seenBy and readBy userIds
      if (Array.isArray(m.seenBy)) {
        m.seenBy.forEach((s) => {
          if (s?.userId && mongoose.Types.ObjectId.isValid(s.userId.toString())) relatedIds.add(s.userId.toString());
        });
      }
      if (Array.isArray(m.readBy)) {
        m.readBy.forEach((r) => {
          if (r && mongoose.Types.ObjectId.isValid(r.toString())) relatedIds.add(r.toString());
        });
      }

      // Collect poll voter IDs
      if (m.type === 'POLL' && m.pollData && Array.isArray(m.pollData.options)) {
        m.pollData.options.forEach((opt) => {
          (opt.votes || []).forEach((v) => {
            const vId = (typeof v === 'object' && (v.userId || v._id || v.id)) ? (v.userId || v._id || v.id).toString() : v?.toString();
            if (vId && mongoose.Types.ObjectId.isValid(vId)) relatedIds.add(vId);
          });
          (opt.voters || []).forEach((v) => {
            const vId = (typeof v === 'object' && (v.userId || v._id || v.id)) ? (v.userId || v._id || v.id).toString() : v?.toString();
            if (vId && mongoose.Types.ObjectId.isValid(vId)) relatedIds.add(vId);
          });
        });
      }
    });

    const relatedIdsArray = Array.from(relatedIds);

    const [liveStudents, liveTeachers, liveUsers] = await Promise.all([
      Student.find({
        $or: [{ _id: { $in: relatedIdsArray } }, { name: { $in: senderNames } }],
      })
        .select('name avatar avatarUrl role enrollmentNo studentLevel')
        .lean()
        .catch(() => []),
      Teacher.find({
        $or: [{ _id: { $in: relatedIdsArray } }, { name: { $in: senderNames } }],
      })
        .select('name avatar avatarUrl role instruments')
        .lean()
        .catch(() => []),
      User.find({
        $or: [{ _id: { $in: relatedIdsArray } }, { name: { $in: senderNames } }],
      })
        .select('name avatar avatarUrl role studentLevel')
        .lean()
        .catch(() => []),
    ]);

    const entityMap = new Map();
    const avatarMap = new Map();

    [...(liveStudents || []), ...(liveTeachers || []), ...(liveUsers || [])].forEach((e) => {
      const av = e.avatarUrl || e.avatar;
      if (e._id) {
        entityMap.set(e._id.toString(), e);
        if (av) avatarMap.set(e._id.toString(), av);
      }
      if (e.name) {
        avatarMap.set(e.name.trim().toLowerCase(), av);
      }
    });

    const messages = rawMessages.map((m) => {
      const obj = m.toObject();
      const sId = (obj.senderId?._id || obj.senderId || '').toString();
      const sName = (obj.senderName || obj.senderId?.name || '').trim().toLowerCase();
      const liveAvatar =
        avatarMap.get(sId) ||
        avatarMap.get(sName) ||
        obj.senderAvatar ||
        obj.senderId?.avatarUrl ||
        obj.senderId?.avatar ||
        null;

      obj.senderAvatar = liveAvatar;
      if (!obj.senderId) {
        obj.senderId = {
          _id: obj.senderName ? `user_${obj.senderName}` : 'user_student',
          name: obj.senderName || 'Student',
          avatarUrl: liveAvatar,
          role: 'STUDENT',
        };
      } else if (typeof obj.senderId === 'object') {
        obj.senderId.avatarUrl = liveAvatar;
      }

      // Populate rich seenBy details
      const rawSeenList = Array.isArray(obj.seenBy) ? obj.seenBy : [];
      const rawReadList = Array.isArray(obj.readBy) ? obj.readBy : [];
      const seenSet = new Set();
      const resolvedSeenBy = [];

      rawSeenList.forEach((s) => {
        if (!s || !s.userId) return;
        const uid = s.userId.toString();
        if (seenSet.has(uid)) return;
        seenSet.add(uid);

        const dbE = entityMap.get(uid);
        resolvedSeenBy.push({
          userId: uid,
          name: dbE?.name || s.name || 'Member',
          avatarUrl: dbE?.avatarUrl || dbE?.avatar || s.avatarUrl || avatarMap.get(uid) || '',
          role: (dbE?.role || s.role || 'STUDENT').toUpperCase(),
          studentLevel: dbE?.studentLevel || s.studentLevel || '',
          enrollmentNo: dbE?.enrollmentNo || s.enrollmentNo || '',
          seenAt: s.seenAt || obj.updatedAt || obj.createdAt,
        });
      });

      rawReadList.forEach((r) => {
        if (!r) return;
        const uid = r.toString();
        if (seenSet.has(uid)) return;
        seenSet.add(uid);

        const dbE = entityMap.get(uid);
        resolvedSeenBy.push({
          userId: uid,
          name: dbE?.name || 'Member',
          avatarUrl: dbE?.avatarUrl || dbE?.avatar || avatarMap.get(uid) || '',
          role: (dbE?.role || 'STUDENT').toUpperCase(),
          studentLevel: dbE?.studentLevel || '',
          enrollmentNo: dbE?.enrollmentNo || '',
          seenAt: obj.updatedAt || obj.createdAt,
        });
      });

      obj.seenBy = resolvedSeenBy;
      obj.seenByCount = resolvedSeenBy.length;

      // Populate rich Poll voters with student details
      if (obj.type === 'POLL' && obj.pollData && Array.isArray(obj.pollData.options)) {
        obj.pollData.options = obj.pollData.options.map((opt) => {
          const rawVotes = Array.isArray(opt.votes) ? opt.votes : [];
          const rawVoters = Array.isArray(opt.voters) ? opt.voters : [];
          const combined = rawVoters.length > 0 ? rawVoters : rawVotes;

          const votersList = [];
          const voterIdSet = new Set();

          combined.forEach((v) => {
            const vId = (typeof v === 'object' && (v.userId || v._id || v.id)) ? (v.userId || v._id || v.id).toString() : v?.toString();
            if (!vId || voterIdSet.has(vId)) return;
            voterIdSet.add(vId);

            const dbE = entityMap.get(vId);
            const vName = dbE?.name || (typeof v === 'object' ? v.name : '') || 'Student';
            const vAvatar = dbE?.avatarUrl || dbE?.avatar || (typeof v === 'object' ? v.avatarUrl : '') || avatarMap.get(vId) || '';
            const vRole = (dbE?.role || (typeof v === 'object' ? v.role : '') || 'STUDENT').toUpperCase();
            const vEnrollment = dbE?.enrollmentNo || (typeof v === 'object' ? v.enrollmentNo : '') || '';
            const vLevel = dbE?.studentLevel || (typeof v === 'object' ? v.studentLevel : '') || '';
            const votedAt = (typeof v === 'object' && v.votedAt) ? v.votedAt : obj.updatedAt || obj.createdAt;

            votersList.push({
              userId: vId,
              name: vName,
              avatarUrl: vAvatar,
              role: vRole,
              enrollmentNo: vEnrollment,
              studentLevel: vLevel,
              votedAt,
            });
          });

          return {
            ...opt,
            votes: votersList.map((v) => v.userId),
            voters: votersList,
          };
        });
      }

      return obj;
    });

    return successResponse(res, { messages: messages.reverse() });
  } catch (err) {
    next(err);
  }
};

const sendMessage = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { text, attachments = [], pollData, metadata = {} } = req.body;
    let type = (req.body.type || 'TEXT').toString().toUpperCase();
    if (type === 'VOICE' || type === 'AUDIO') type = 'VOICE';
    if (type === 'DOC' || type === 'PDF') type = 'DOCUMENT';
    let senderId = req.body.senderId || req.user?.userId;
    let senderName = req.body.senderName || req.user?.name;
    let senderAvatar = req.body.avatarUrl || req.body.senderAvatar || req.user?.avatarUrl;

    // Check if group exists and whether chat is enabled
    const group = await Group.findById(groupId);
    if (!group) {
      return errorResponse(res, 'Batch group not found.', statusCodes.NOT_FOUND);
    }

    if (group.chatSettings && group.chatSettings.isChatEnabled === false) {
      const allowedRoles = ['ADMIN', 'MANAGER', 'TEACHER'];
      const userRole = (req.user?.role || req.body.role || '').toUpperCase();
      if (!allowedRoles.includes(userRole)) {
        return errorResponse(
          res,
          'Messaging is currently disabled by administrator for this batch.',
          statusCodes.FORBIDDEN
        );
      }
    }

    if (type === 'POLL' && group.chatSettings && group.chatSettings.pollsEnabled === false) {
      const allowedRoles = ['ADMIN', 'MANAGER', 'TEACHER'];
      const userRole = (req.user?.role || req.body.role || '').toUpperCase();
      if (!allowedRoles.includes(userRole)) {
        return errorResponse(
          res,
          'Poll creation has been disabled by the administrator for this batch.',
          statusCodes.FORBIDDEN
        );
      }
    }

    let resolvedUser = null;
    if (senderId && mongoose.Types.ObjectId.isValid(senderId)) {
      resolvedUser = await Student.findById(senderId)
        .select('name avatar avatarUrl role')
        .lean()
        .catch(() => null);
      if (!resolvedUser) {
        resolvedUser = await Teacher.findById(senderId)
          .select('name avatar avatarUrl role')
          .lean()
          .catch(() => null);
      }
      if (!resolvedUser) {
        resolvedUser = await User.findById(senderId)
          .select('name avatar avatarUrl role')
          .lean()
          .catch(() => null);
      }
    }

    if (!senderId || !mongoose.Types.ObjectId.isValid(senderId)) {
      if (resolvedUser?._id) {
        senderId = resolvedUser._id;
      } else {
        const fallbackUser = await User.findOne({ role: 'ADMIN' })
          .select('_id name avatarUrl')
          .lean()
          .catch(() => null);
        senderId = fallbackUser?._id || new mongoose.Types.ObjectId();
      }
    }

    let cleanPollData = null;
    if (pollData && typeof pollData === 'object') {
      const question = pollData.question || text || 'Poll';
      const rawOpts = Array.isArray(pollData.options) ? pollData.options : [];
      const cleanOpts = rawOpts.map((opt, i) => {
        const title = typeof opt === 'string' ? opt : opt.title || opt.text || `Option ${i + 1}`;
        return {
          id: opt.id || `opt_${i}`,
          title,
          text: title,
          votes: Array.isArray(opt.votes) ? opt.votes : [],
          voters: Array.isArray(opt.voters) ? opt.voters : [],
        };
      });

      cleanPollData = {
        question,
        options: cleanOpts,
        closed: Boolean(pollData.closed),
      };
    }

    let cleanAttachments = Array.isArray(attachments) ? attachments.filter((a) => a && typeof a === 'object') : [];
    const fileUrl = metadata.fileUrl || metadata.url || metadata.imageUrl || metadata.audioUrl;
    if (cleanAttachments.length === 0 && fileUrl) {
      cleanAttachments = [
        {
          url: fileUrl,
          fileName: metadata.fileName || 'Attachment',
          fileSize: metadata.fileSize || 'File',
          fileType: metadata.fileType || type.toLowerCase(),
        },
      ];
    }

    if (!metadata.fileUrl && cleanAttachments.length > 0 && cleanAttachments[0].url) {
      metadata.fileUrl = cleanAttachments[0].url;
    }
    if (!metadata.fileName && cleanAttachments.length > 0 && cleanAttachments[0].fileName) {
      metadata.fileName = cleanAttachments[0].fileName;
    }
    if (!metadata.fileSize && cleanAttachments.length > 0 && cleanAttachments[0].fileSize) {
      metadata.fileSize = cleanAttachments[0].fileSize;
    }

    // Include sender in initial seenBy and readBy
    const senderSeenObj = {
      userId: senderId ? senderId.toString() : 'sender',
      name: senderName || resolvedUser?.name || 'Sender',
      avatarUrl: senderAvatar || resolvedUser?.avatarUrl || '',
      role: (req.user?.role || req.body.role || (resolvedUser?.role) || 'STUDENT').toUpperCase(),
      seenAt: new Date(),
    };

    const message = await Message.create({
      groupId,
      senderId,
      senderName: senderName || resolvedUser?.name,
      senderAvatar: senderAvatar || resolvedUser?.avatarUrl,
      text,
      type,
      attachments: cleanAttachments,
      metadata,
      pollData: cleanPollData,
      replyTo: req.body.replyTo || null,
      isForwarded: Boolean(req.body.isForwarded),
      readBy: senderId ? [senderId] : [],
      seenBy: [senderSeenObj],
    });

    const populated = await Message.findById(message._id).populate('senderId', 'name avatarUrl role email');

    // Universal Real-Time Broadcast (Socket.IO + WebSocket)
    try {
      broadcast(socketEvents.NEW_MESSAGE, populated, groupId);
    } catch (e) {
      console.warn('[Broadcast Error in sendMessage]:', e.message);
    }

    // Native Push Notification Dispatch (FCM)
    fcmService.sendChatMessageNotification({
      message: populated,
      group: group,
      senderId: senderId || req.user?.userId || resolvedUser?._id,
    }).catch((fcmErr) => {
      console.warn('[FCM Chat Notification Warning]:', fcmErr.message);
    });

    return successResponse(res, { message: populated }, 'Message sent.', statusCodes.CREATED);
  } catch (err) {
    next(err);
  }
};

/**
 * Vote on a Poll Message
 * Supports recording student details for each poll choice
 */
const votePoll = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { optionIndex = 0 } = req.body;
    const rawUserId = req.body.userId || req.user?.userId || 'dev_student_id';
    const rawUserName = req.body.name || req.body.userName || req.user?.name || '';
    const rawAvatarUrl = req.body.avatarUrl || req.user?.avatarUrl || '';
    const rawRole = (req.body.role || req.user?.role || 'STUDENT').toUpperCase();

    const message = await Message.findById(messageId);
    if (!message || message.type !== 'POLL' || !message.pollData) {
      return errorResponse(res, 'Poll message not found.', statusCodes.NOT_FOUND);
    }

    if (message.pollData.closed) {
      return errorResponse(res, 'This poll has been closed.', statusCodes.BAD_REQUEST);
    }

    const options = message.pollData.options || [];
    const idx = parseInt(optionIndex);
    if (isNaN(idx) || idx < 0 || idx >= options.length) {
      return errorResponse(res, 'Invalid option index.', statusCodes.BAD_REQUEST);
    }

    // Resolve full user & student details
    const voterInfo = await resolveUserDetails(rawUserId, rawUserName, rawAvatarUrl, rawRole);
    voterInfo.votedAt = new Date();

    const getVoterId = (v) => {
      if (!v) return '';
      if (typeof v === 'object' && (v.userId || v._id || v.id)) {
        return (v.userId || v._id || v.id).toString();
      }
      return v.toString();
    };

    // Single-choice voting logic: remove user from all options, then add to selected option
    options.forEach((opt, i) => {
      let voteList = Array.isArray(opt.votes) ? opt.votes : [];
      voteList = voteList.filter((v) => getVoterId(v) !== voterInfo.userId.toString());

      let votersList = Array.isArray(opt.voters) ? opt.voters : [];
      votersList = votersList.filter((v) => getVoterId(v) !== voterInfo.userId.toString());

      if (i === idx) {
        voteList.push(voterInfo.userId.toString());
        votersList.push(voterInfo);
      }
      opt.votes = voteList;
      opt.voters = votersList;
    });

    message.markModified('pollData');
    await message.save();

    const populated = await Message.findById(message._id).populate('senderId', 'name avatarUrl role email');

    // Broadcast poll update over Socket.IO and Native WebSocket
    try {
      broadcast(socketEvents.NEW_MESSAGE, populated, message.groupId);
      broadcast(socketEvents.POLL_VOTED, populated, message.groupId);
    } catch (e) {
      console.warn('[Broadcast Error in votePoll]:', e.message);
    }

    return successResponse(res, { message: populated }, 'Vote recorded successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Get detailed list of voters per poll choice (Students and Teachers breakdown)
 */
const getPollVoters = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const message = await Message.findById(messageId);
    if (!message || message.type !== 'POLL' || !message.pollData) {
      return errorResponse(res, 'Poll message not found.', statusCodes.NOT_FOUND);
    }

    const options = message.pollData.options || [];

    // Collect all unique user IDs that voted
    const allVoterIds = [];
    options.forEach((opt) => {
      const votes = opt.votes || [];
      const voters = opt.voters || [];
      [...votes, ...voters].forEach((v) => {
        const id = (typeof v === 'object' && (v.userId || v._id || v.id)) ? (v.userId || v._id || v.id).toString() : v?.toString();
        if (id && mongoose.Types.ObjectId.isValid(id)) {
          allVoterIds.push(id);
        }
      });
    });

    const [students, teachers, users] = await Promise.all([
      Student.find({ _id: { $in: allVoterIds } }).select('name avatar avatarUrl role enrollmentNo studentLevel').lean().catch(() => []),
      Teacher.find({ _id: { $in: allVoterIds } }).select('name avatar avatarUrl role instruments').lean().catch(() => []),
      User.find({ _id: { $in: allVoterIds } }).select('name avatar avatarUrl role studentLevel').lean().catch(() => []),
    ]);

    const entityMap = new Map();
    [...(students || []), ...(teachers || []), ...(users || [])].forEach((e) => {
      if (e._id) {
        entityMap.set(e._id.toString(), e);
      }
    });

    let totalVotes = 0;
    const resolvedOptions = options.map((opt, idx) => {
      const rawList = (opt.voters && opt.voters.length > 0) ? opt.voters : (opt.votes || []);
      const studentsVoted = [];
      const teachersVoted = [];
      const allVoters = [];

      rawList.forEach((v) => {
        const vId = (typeof v === 'object' && (v.userId || v._id || v.id)) ? (v.userId || v._id || v.id).toString() : v?.toString();
        const dbEntity = entityMap.get(vId);

        const vName = dbEntity?.name || (typeof v === 'object' ? v.name : '') || 'Student';
        const vAvatar = dbEntity?.avatarUrl || dbEntity?.avatar || (typeof v === 'object' ? v.avatarUrl : '') || '';
        const vRole = (dbEntity?.role || (typeof v === 'object' ? v.role : '') || (teachers.some(t => t._id.toString() === vId) ? 'TEACHER' : 'STUDENT')).toUpperCase();
        const vEnrollment = dbEntity?.enrollmentNo || (typeof v === 'object' ? v.enrollmentNo : '') || '';
        const vLevel = dbEntity?.studentLevel || (typeof v === 'object' ? v.studentLevel : '') || '';
        const votedAt = (typeof v === 'object' && v.votedAt) ? v.votedAt : message.updatedAt || message.createdAt;

        const voterObj = {
          userId: vId,
          name: vName,
          avatarUrl: vAvatar,
          role: vRole,
          enrollmentNo: vEnrollment,
          studentLevel: vLevel,
          votedAt,
        };

        allVoters.push(voterObj);
        if (vRole === 'TEACHER' || vRole === 'ADMIN' || vRole === 'MANAGER') {
          teachersVoted.push(voterObj);
        } else {
          studentsVoted.push(voterObj);
        }
      });

      totalVotes += allVoters.length;

      return {
        id: opt.id || `opt_${idx}`,
        title: opt.title || opt.text || `Option ${idx + 1}`,
        votesCount: allVoters.length,
        voters: allVoters,
        students: studentsVoted,
        teachers: teachersVoted,
      };
    });

    return successResponse(res, {
      messageId: message._id,
      question: message.pollData.question || message.text || 'Poll',
      totalVotes,
      options: resolvedOptions,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Mark a single message as seen / read
 */
const markMessageAsRead = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.body.userId || req.user?.userId || 'dev_student_id';
    const userName = req.body.name || req.body.userName || req.user?.name || '';
    const avatarUrl = req.body.avatarUrl || req.user?.avatarUrl || '';
    const role = (req.body.role || req.user?.role || 'STUDENT').toUpperCase();

    const message = await Message.findById(messageId);
    if (!message) {
      return errorResponse(res, 'Message not found.', statusCodes.NOT_FOUND);
    }

    const readerInfo = await resolveUserDetails(userId, userName, avatarUrl, role);
    readerInfo.seenAt = new Date();

    const seenList = Array.isArray(message.seenBy) ? message.seenBy : [];
    const alreadySeen = seenList.some((s) => s && s.userId?.toString() === userId.toString());

    if (!alreadySeen) {
      seenList.push(readerInfo);
      message.seenBy = seenList;
    }

    const readByList = Array.isArray(message.readBy) ? message.readBy : [];
    if (!readByList.some((r) => r?.toString() === userId.toString())) {
      readByList.push(userId);
      message.readBy = readByList;
    }

    message.markModified('seenBy');
    message.markModified('readBy');
    await message.save();

    try {
      broadcast(
        'message_read_update',
        {
          messageId: message._id,
          groupId: message.groupId,
          reader: readerInfo,
          seenByCount: message.seenBy.length,
        },
        message.groupId
      );
    } catch (e) {
      console.warn('[Broadcast Error in markMessageAsRead]:', e.message);
    }

    return successResponse(
      res,
      {
        messageId: message._id,
        seenByCount: message.seenBy.length,
        reader: readerInfo,
      },
      'Message marked as seen.'
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Mark all messages in a group as seen / read by user
 */
const markGroupMessagesAsRead = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const userId = req.body.userId || req.user?.userId || 'dev_student_id';
    const userName = req.body.name || req.body.userName || req.user?.name || '';
    const avatarUrl = req.body.avatarUrl || req.user?.avatarUrl || '';
    const role = (req.body.role || req.user?.role || 'STUDENT').toUpperCase();

    const readerInfo = await resolveUserDetails(userId, userName, avatarUrl, role);
    readerInfo.seenAt = new Date();

    const userIdStr = userId.toString();
    const userObjIds = [userIdStr];
    if (mongoose.Types.ObjectId.isValid(userIdStr)) {
      userObjIds.push(new mongoose.Types.ObjectId(userIdStr));
    }

    const groupObjIds = [groupId];
    if (mongoose.Types.ObjectId.isValid(groupId)) {
      groupObjIds.push(new mongoose.Types.ObjectId(groupId));
    }

    const messages = await Message.find({
      groupId: { $in: groupObjIds },
      $or: [
        { readBy: { $nin: userObjIds } },
        { 'seenBy.userId': { $ne: userIdStr } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(300);

    if (messages.length > 0) {
      const msgIds = messages.map((m) => m._id);
      await Message.updateMany(
        { _id: { $in: msgIds } },
        {
          $addToSet: {
            readBy: { $each: userObjIds },
            seenBy: readerInfo,
          },
        }
      );

      try {
        broadcast(
          'message_read_update',
          {
            groupId,
            userId: userIdStr,
            reader: readerInfo,
            messageIds: msgIds,
          },
          groupId
        );
        broadcast('group_updated', { groupId });
      } catch (e) {
        console.warn('[Broadcast Error in markGroupMessagesAsRead]:', e.message);
      }
    }

    return successResponse(res, { markedCount: messages.length }, 'Messages marked as seen.');
  } catch (err) {
    next(err);
  }
};

/**
 * Get read receipts for a message (Students and Teachers breakdown)
 */
const getMessageReadReceipts = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const message = await Message.findById(messageId);
    if (!message) {
      return errorResponse(res, 'Message not found.', statusCodes.NOT_FOUND);
    }

    const seenByRaw = Array.isArray(message.seenBy) ? message.seenBy : [];
    const readByRaw = Array.isArray(message.readBy) ? message.readBy : [];

    const seenUserIds = new Set();
    seenByRaw.forEach((s) => {
      if (s?.userId) seenUserIds.add(s.userId.toString());
    });
    readByRaw.forEach((r) => {
      if (r) seenUserIds.add(r.toString());
    });

    const userIdsArray = Array.from(seenUserIds).filter((id) => mongoose.Types.ObjectId.isValid(id));

    const [students, teachers, users, group] = await Promise.all([
      Student.find({ _id: { $in: userIdsArray } }).select('name avatar avatarUrl role enrollmentNo studentLevel').lean().catch(() => []),
      Teacher.find({ _id: { $in: userIdsArray } }).select('name avatar avatarUrl role instruments').lean().catch(() => []),
      User.find({ _id: { $in: userIdsArray } }).select('name avatar avatarUrl role studentLevel').lean().catch(() => []),
      Group.findById(message.groupId).select('name members teacherIds studentIds').lean().catch(() => null),
    ]);

    const entityMap = new Map();
    [...(students || []), ...(teachers || []), ...(users || [])].forEach((e) => {
      if (e._id) entityMap.set(e._id.toString(), e);
    });

    const teachersSeen = [];
    const studentsSeen = [];
    const allSeen = [];

    seenUserIds.forEach((uid) => {
      const existingSeen = seenByRaw.find((s) => s && s.userId?.toString() === uid);
      const dbEntity = entityMap.get(uid);

      const name = dbEntity?.name || existingSeen?.name || 'Member';
      const avatarUrl = dbEntity?.avatarUrl || dbEntity?.avatar || existingSeen?.avatarUrl || '';
      const isTeacherEntity = teachers.some((t) => t._id.toString() === uid);
      const role = (dbEntity?.role || existingSeen?.role || (isTeacherEntity ? 'TEACHER' : 'STUDENT')).toUpperCase();
      const enrollmentNo = dbEntity?.enrollmentNo || '';
      const studentLevel = dbEntity?.studentLevel || '';
      const seenAt = existingSeen?.seenAt || message.updatedAt || message.createdAt;

      const viewer = {
        userId: uid,
        name,
        avatarUrl,
        role,
        enrollmentNo,
        studentLevel,
        seenAt,
      };

      allSeen.push(viewer);
      if (role === 'TEACHER' || role === 'ADMIN' || role === 'MANAGER') {
        teachersSeen.push(viewer);
      } else {
        studentsSeen.push(viewer);
      }
    });

    const groupMemberCount = (group?.members?.length || 0) + (group?.studentIds?.length || 0) + (group?.teacherIds?.length || 0) || allSeen.length;

    return successResponse(res, {
      messageId: message._id,
      sentAt: message.createdAt,
      text: message.text,
      type: message.type,
      totalSeenCount: allSeen.length,
      groupMemberCount: Math.max(groupMemberCount, allSeen.length),
      teachers: teachersSeen,
      students: studentsSeen,
      allSeen,
    });
  } catch (err) {
    next(err);
  }
};

const resolveUploadCategory = (fileName = '', fileType = '') => {
  const ext = path.extname(fileName).toLowerCase();
  const mime = (fileType || '').toLowerCase();

  // Audio files (voice notes, m4a, mp3, etc.)
  if (
    mime.startsWith('audio/') ||
    ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.opus', '.flac', '.wma', '.amr'].includes(ext) ||
    fileName.toLowerCase().includes('voice_')
  ) {
    return 'audio';
  }

  // Image files (photos, screenshots, avatars)
  if (
    mime.startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)
  ) {
    return 'images';
  }

  // Video files (recordings, clips)
  if (
    mime.startsWith('video/') ||
    ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp'].includes(ext)
  ) {
    return 'videos';
  }

  // Documents (PDFs, Word docs, Excel, text, presentations)
  return 'documents';
};

const uploadFile = async (req, res, next) => {
  try {
    const { fileData, fileName = `media_${Date.now()}.jpg`, fileType } = req.body;
    if (!fileData) {
      return errorResponse(res, 'No file data provided.', statusCodes.BAD_REQUEST);
    }

    const cleanBase64 = fileData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const uploadsDir = path.join(__dirname, '../../uploads');

    const category = resolveUploadCategory(fileName, fileType);
    const categoryDir = path.join(uploadsDir, category);

    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    const filePath = path.join(categoryDir, safeName);
    fs.writeFileSync(filePath, buffer);

    let host = req.get('host') || '192.168.1.10:5000';
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
      host = process.env.SERVER_HOST || '192.168.1.10:5000';
    }
    const protocol = req.protocol || 'http';
    const fileUrl = `${protocol}://${host}/uploads/${category}/${safeName}`;

    return successResponse(
      res,
      {
        url: fileUrl,
        category,
        fileName: safeName,
        fileSize: `${(buffer.length / 1024).toFixed(1)} KB`,
        fileType: fileType || (category === 'audio' ? 'audio/m4a' : (category === 'documents' ? 'application/pdf' : 'image/jpeg')),
      },
      'File uploaded successfully.',
      statusCodes.CREATED
    );
  } catch (err) {
    next(err);
  }
};

const editMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { text } = req.body;
    const userId = req.user?.userId;
    const userRole = req.user?.role || 'STUDENT';

    if (!text || !text.trim()) {
      return errorResponse(res, 'Message text cannot be empty.', statusCodes.BAD_REQUEST);
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return errorResponse(res, 'Message not found.', statusCodes.NOT_FOUND);
    }

    const isSender = message.senderId && message.senderId.toString() === userId?.toString();
    const isAdmin = userRole === 'ADMIN' || userRole === 'MANAGER';
    if (!isSender && !isAdmin) {
      return errorResponse(res, 'You can only edit your own messages.', statusCodes.FORBIDDEN);
    }

    message.text = text.trim();
    message.isEdited = true;
    await message.save();

    const populated = await Message.findById(messageId).populate('senderId', 'name avatarUrl role email');

    try {
      broadcast(socketEvents.MESSAGE_UPDATED, populated, message.groupId);
    } catch (e) {
      console.warn('[Broadcast Error in editMessage]:', e.message);
    }

    return successResponse(res, { message: populated }, 'Message updated successfully.');
  } catch (err) {
    next(err);
  }
};

const deleteMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.user?.userId;
    const userRole = req.user?.role || 'STUDENT';

    const message = await Message.findById(messageId);
    if (!message) {
      return errorResponse(res, 'Message not found.', statusCodes.NOT_FOUND);
    }

    const isSender = message.senderId && message.senderId.toString() === userId?.toString();
    const isAdmin = userRole === 'ADMIN' || userRole === 'MANAGER';
    if (!isSender && !isAdmin) {
      return errorResponse(res, 'You can only delete your own messages.', statusCodes.FORBIDDEN);
    }

    const groupId = message.groupId;
    await Message.findByIdAndDelete(messageId);

    try {
      broadcast('message_deleted', { messageId, groupId }, groupId);
    } catch (e) {
      console.warn('[Broadcast Error in deleteMessage]:', e.message);
    }

    return successResponse(res, { messageId, groupId }, 'Message deleted successfully.');
  } catch (err) {
    next(err);
  }
};

const reactToMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user?.userId || req.body.userId || 'dev_user';
    const userName = req.user?.name || req.body.userName || 'User';

    const message = await Message.findById(messageId);
    if (!message) {
      return errorResponse(res, 'Message not found.', statusCodes.NOT_FOUND);
    }

    if (!Array.isArray(message.reactions)) {
      message.reactions = [];
    }

    const existingIdx = message.reactions.findIndex((r) => r.userId === userId.toString() && r.emoji === emoji);
    if (existingIdx !== -1) {
      // Toggle off reaction if already reacted with same emoji
      message.reactions.splice(existingIdx, 1);
    } else {
      // Remove previous reaction from this user if any, and add new one
      message.reactions = message.reactions.filter((r) => r.userId !== userId.toString());
      message.reactions.push({ userId: userId.toString(), emoji, userName });
    }

    await message.save();

    try {
      broadcast('message_reaction', { messageId, reactions: message.reactions, groupId: message.groupId }, message.groupId);
    } catch (e) {
      console.warn('[Broadcast Error in reactToMessage]:', e.message);
    }

    return successResponse(res, { message }, 'Reaction updated.');
  } catch (err) {
    next(err);
  }
};

const pinMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const message = await Message.findById(messageId);
    if (!message) {
      return errorResponse(res, 'Message not found.', statusCodes.NOT_FOUND);
    }

    message.isPinned = !message.isPinned;
    await message.save();

    try {
      broadcast('message_pinned', { messageId, isPinned: message.isPinned, groupId: message.groupId }, message.groupId);
    } catch (e) {
      console.warn('[Broadcast Error in pinMessage]:', e.message);
    }

    return successResponse(res, { messageId, isPinned: message.isPinned }, 'Message pin toggled.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getMessages,
  sendMessage,
  votePoll,
  getPollVoters,
  markMessageAsRead,
  markGroupMessagesAsRead,
  getMessageReadReceipts,
  uploadFile,
  editMessage,
  deleteMessage,
  reactToMessage,
  pinMessage,
};
