const mongoose = require('mongoose');
const Message = require('../models/Message');
const ScheduledMessage = require('../models/ScheduledMessage');
const Group = require('../models/Group');
const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const { broadcast } = require('../config/socket');
const socketEvents = require('../constants/socketEvents');
const fcmService = require('./fcm.service');
const logger = require('../utils/logger');

class ChatService {
  /**
   * Resolves unified user details across Student, Teacher, and User collections
   */
  async resolveUserDetails(userId, fallbackName = '', fallbackAvatar = '', fallbackRole = '') {
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
      } catch (_) {}
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
      } catch (_) {}
    }

    return {
      userId: idStr,
      name: name || (role === 'TEACHER' ? 'Teacher' : 'Student'),
      avatarUrl,
      role: role.toUpperCase(),
      enrollmentNo,
      studentLevel,
    };
  }

  /**
   * Fetch group message history with rich population, search, pagination, and voter breakdown
   */
  async fetchHistory(groupId, options = {}) {
    const {
      page = 1,
      limit = 100,
      search = '',
      type = '',
      pinned = false,
      userId = '',
    } = options;

    const filter = { groupId };

    // Exclude messages soft-deleted or deleted for this specific user
    filter.isDeleted = { $ne: true };
    if (userId) {
      filter.deletedFor = { $nin: [userId.toString()] };
    }

    // Filter by type if requested
    if (type && type !== 'ALL') {
      if (type.toUpperCase() === 'MEDIA') {
        filter.type = { $in: ['IMAGE', 'VIDEO', 'VOICE', 'AUDIO', 'DOCUMENT', 'FILE'] };
      } else {
        filter.type = type.toUpperCase();
      }
    }

    // Filter by pinned state if requested
    if (pinned === true || pinned === 'true') {
      filter.isPinned = true;
    }

    // Search query filter (text, file name, or sender name)
    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { text: { $regex: q, $options: 'i' } },
        { senderName: { $regex: q, $options: 'i' } },
        { 'attachments.fileName': { $regex: q, $options: 'i' } },
        { 'metadata.fileName': { $regex: q, $options: 'i' } },
        { 'pollData.question': { $regex: q, $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [rawMessages, totalMessages] = await Promise.all([
      Message.find(filter)
        .populate('senderId', 'name avatarUrl role email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Message.countDocuments(filter),
    ]);

    // Resolve up-to-date sender, voter, and reader avatars and details
    const senderNames = [...new Set(rawMessages.map((m) => m.senderName).filter(Boolean))];
    const relatedIds = new Set();

    rawMessages.forEach((m) => {
      const sId = m.senderId?._id || m.senderId;
      if (sId && mongoose.Types.ObjectId.isValid(sId.toString())) relatedIds.add(sId.toString());

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

      // Populate rich Poll voters with student & teacher details
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

    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    const totalPages = Math.ceil(totalMessages / parsedLimit) || 1;

    return {
      messages: messages.reverse(),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        totalMessages,
        totalPages,
        hasMore: parsedPage < totalPages,
      },
    };
  }

  /**
   * Send a new message to a group
   */
  async createMessage(groupId, messageData, senderContext = {}) {
    const { text = '', attachments = [], pollData, metadata = {}, replyTo, isForwarded = false } = messageData;
    let type = (messageData.type || 'TEXT').toString().toUpperCase();
    if (type === 'VOICE' || type === 'AUDIO') type = 'VOICE';
    if (type === 'DOC' || type === 'PDF') type = 'DOCUMENT';
    if (type === 'VID' || type === 'MOV' || type === 'MP4') type = 'VIDEO';

    let senderId = messageData.senderId || senderContext.userId;
    let senderName = messageData.senderName || senderContext.name;
    let senderAvatar = messageData.avatarUrl || messageData.senderAvatar || senderContext.avatarUrl;
    let senderRole = (messageData.role || senderContext.role || 'STUDENT').toUpperCase();

    // Resolve sender entity from database first to verify true identity and role
    let resolvedUser = null;
    if (senderId && mongoose.Types.ObjectId.isValid(senderId)) {
      resolvedUser = await Student.findById(senderId).select('name avatar avatarUrl role').lean().catch(() => null)
        || await Teacher.findById(senderId).select('name avatar avatarUrl role').lean().catch(() => null)
        || await User.findById(senderId).select('name avatar avatarUrl role').lean().catch(() => null);
    }

    if (resolvedUser?.role) {
      senderRole = resolvedUser.role.toUpperCase();
    }

    const group = await Group.findById(groupId);
    if (!group) {
      throw new Error('Batch group not found.');
    }

    // Permission checks: When administrator disables chat, only system ADMIN or MANAGER can post.
    // Teachers and Students in the mobile app are strictly restricted.
    const isSuperAdmin = ['ADMIN', 'MANAGER'].includes(senderRole);
    if (group.chatSettings && group.chatSettings.chatEnabled === false && !isSuperAdmin) {
      throw new Error('Messaging is currently disabled by administrator for this batch.');
    }
    const isTeacherOrAdmin = ['ADMIN', 'MANAGER', 'TEACHER'].includes(senderRole);
    if (type === 'POLL' && group.chatSettings && group.chatSettings.pollsEnabled === false && !isTeacherOrAdmin) {
      throw new Error('Poll creation has been disabled by administrator for this batch.');
    }

    if (!senderId || !mongoose.Types.ObjectId.isValid(senderId)) {
      if (resolvedUser?._id) {
        senderId = resolvedUser._id;
      } else {
        const fallbackUser = await User.findOne({ role: 'ADMIN' }).select('_id name avatarUrl').lean().catch(() => null);
        senderId = fallbackUser?._id || new mongoose.Types.ObjectId();
      }
    }

    senderName = senderName || resolvedUser?.name || 'Sender';
    senderAvatar = senderAvatar || resolvedUser?.avatarUrl || '';

    // Sanitize Poll Data
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
        isMultipleChoice: Boolean(pollData.isMultipleChoice),
        allowAnonymous: Boolean(pollData.allowAnonymous),
        closed: Boolean(pollData.closed),
      };
    }

    // Sanitize Attachments
    let cleanAttachments = Array.isArray(attachments) ? attachments.filter((a) => a && typeof a === 'object') : [];
    const fileUrl = metadata.fileUrl || metadata.url || metadata.imageUrl || metadata.audioUrl || metadata.videoUrl;
    if (cleanAttachments.length === 0 && fileUrl) {
      cleanAttachments = [
        {
          url: fileUrl,
          fileName: metadata.fileName || 'Attachment',
          fileSize: metadata.fileSize || 'File',
          fileType: metadata.fileType || (type === 'VIDEO' ? 'video/mp4' : type.toLowerCase()),
        },
      ];
    }

    if (!metadata.fileUrl && cleanAttachments.length > 0 && cleanAttachments[0].url) {
      metadata.fileUrl = cleanAttachments[0].url;
    }
    if (!metadata.videoUrl && type === 'VIDEO' && cleanAttachments.length > 0 && cleanAttachments[0].url) {
      metadata.videoUrl = cleanAttachments[0].url;
    }
    if (!metadata.audioUrl && (type === 'VOICE' || type === 'AUDIO') && cleanAttachments.length > 0 && cleanAttachments[0].url) {
      metadata.audioUrl = cleanAttachments[0].url;
    }
    if (!metadata.fileName && cleanAttachments.length > 0 && cleanAttachments[0].fileName) {
      metadata.fileName = cleanAttachments[0].fileName;
    }
    if (!metadata.fileSize && cleanAttachments.length > 0 && cleanAttachments[0].fileSize) {
      metadata.fileSize = cleanAttachments[0].fileSize;
    }

    // Initial seenBy and readBy
    const senderSeenObj = {
      userId: senderId ? senderId.toString() : 'sender',
      name: senderName,
      avatarUrl: senderAvatar,
      role: senderRole,
      seenAt: new Date(),
    };

    // Process and validate Mentions
    let cleanMentions = [];
    if (Array.isArray(messageData.mentions)) {
      cleanMentions = messageData.mentions
        .filter((m) => m && (m.userId || m.name || m.id))
        .map((m) => ({
          userId: (m.userId || m.id || '').toString(),
          name: (m.name || '').toString().trim(),
        }));
    }

    // Auto-detect mentions in text if not explicitly supplied
    if (cleanMentions.length === 0 && text && text.includes('@')) {
      const mentionMatches = text.match(/@([a-zA-Z0-9_\u0900-\u097F]+)/g);
      if (mentionMatches) {
        mentionMatches.forEach((mStr) => {
          const rawName = mStr.replace(/^@/, '').trim();
          if (rawName.toLowerCase() === 'everyone' || rawName.toLowerCase() === 'all') {
            cleanMentions.push({ userId: 'all', name: 'everyone' });
          } else {
            cleanMentions.push({ userId: '', name: rawName });
          }
        });
      }
    }

    // Extract mentioned names list for fast search and display
    const mentionedNames = [
      ...new Set(cleanMentions.map((m) => m.name).filter(Boolean)),
    ];

    const message = await Message.create({
      groupId,
      senderId,
      senderName,
      senderAvatar,
      text,
      type,
      attachments: cleanAttachments,
      metadata,
      pollData: cleanPollData,
      replyTo: replyTo || null,
      isForwarded: Boolean(isForwarded),
      mentions: cleanMentions,
      mentionedNames,
      readBy: senderId ? [senderId] : [],
      seenBy: [senderSeenObj],
    });

    const populated = await Message.findById(message._id).populate('senderId', 'name avatarUrl role email');

    // Universal Real-Time Broadcast (Socket.IO + Native WebSocket)
    try {
      broadcast(socketEvents.NEW_MESSAGE, populated, groupId);
    } catch (e) {
      logger.warn('[Broadcast Error in ChatService.createMessage]:', e.message);
    }

    // Native Push Notification Dispatch (FCM)
    fcmService.sendChatMessageNotification({
      message: populated,
      group,
      senderId,
    }).catch((fcmErr) => {
      logger.warn('[FCM Chat Notification Warning]:', fcmErr.message);
    });

    return populated;
  }

  /**
   * Vote on a poll choice
   */
  async votePoll(messageId, optionIndex, voterData = {}) {
    const message = await Message.findById(messageId);
    if (!message || message.type !== 'POLL' || !message.pollData) {
      throw new Error('Poll message not found.');
    }

    if (message.pollData.closed) {
      throw new Error('This poll has been closed.');
    }

    const options = message.pollData.options || [];
    const idx = parseInt(optionIndex);
    if (isNaN(idx) || idx < 0 || idx >= options.length) {
      throw new Error('Invalid option index.');
    }

    const voterInfo = await this.resolveUserDetails(
      voterData.userId,
      voterData.name || voterData.userName,
      voterData.avatarUrl,
      voterData.role
    );
    voterInfo.votedAt = new Date();

    const getVoterId = (v) => {
      if (!v) return '';
      if (typeof v === 'object' && (v.userId || v._id || v.id)) {
        return (v.userId || v._id || v.id).toString();
      }
      return v.toString();
    };

    const isMulti = Boolean(message.pollData.isMultipleChoice);
    const voterIdStr = voterInfo.userId.toString();

    if (isMulti) {
      // Multiple-choice voting: Toggle selection for option at idx, preserving other options
      const opt = options[idx];
      let voteList = Array.isArray(opt.votes) ? opt.votes : [];
      let votersList = Array.isArray(opt.voters) ? opt.voters : [];

      const alreadyVotedThis = voteList.some((v) => getVoterId(v) === voterIdStr);
      if (alreadyVotedThis) {
        // Toggle OFF (unvote)
        opt.votes = voteList.filter((v) => getVoterId(v) !== voterIdStr);
        opt.voters = votersList.filter((v) => getVoterId(v) !== voterIdStr);
      } else {
        // Add vote
        voteList.push(voterIdStr);
        votersList.push(voterInfo);
        opt.votes = voteList;
        opt.voters = votersList;
      }
    } else {
      // Single-choice voting: Toggle or move selection
      const targetOpt = options[idx];
      const targetVoteList = Array.isArray(targetOpt.votes) ? targetOpt.votes : [];
      const alreadyVotedThis = targetVoteList.some((v) => getVoterId(v) === voterIdStr);

      options.forEach((opt, i) => {
        let voteList = Array.isArray(opt.votes) ? opt.votes : [];
        let votersList = Array.isArray(opt.voters) ? opt.voters : [];

        // Remove from all options
        voteList = voteList.filter((v) => getVoterId(v) !== voterIdStr);
        votersList = votersList.filter((v) => getVoterId(v) !== voterIdStr);

        // If not already voted on this exact option, select it; if already voted, toggles off
        if (i === idx && !alreadyVotedThis) {
          voteList.push(voterIdStr);
          votersList.push(voterInfo);
        }
        opt.votes = voteList;
        opt.voters = votersList;
      });
    }

    message.markModified('pollData');
    await message.save();

    const populated = await Message.findById(message._id).populate('senderId', 'name avatarUrl role email');

    try {
      broadcast(socketEvents.NEW_MESSAGE, populated, message.groupId);
      broadcast(socketEvents.POLL_VOTED, populated, message.groupId);
    } catch (e) {
      logger.warn('[Broadcast Error in ChatService.votePoll]:', e.message);
    }

    return populated;
  }

  /**
   * Close or Reopen a Poll
   */
  async togglePollStatus(messageId, shouldClose = true, userData = {}) {
    const message = await Message.findById(messageId);
    if (!message || message.type !== 'POLL' || !message.pollData) {
      throw new Error('Poll message not found.');
    }

    const group = await Group.findById(message.groupId);
    const isSender = message.senderId && message.senderId.toString() === userData.userId?.toString();
    const isAdmin = ['ADMIN', 'MANAGER'].includes(userData.role);
    const isTeacherOfGroup = group && (
      (group.teacherId && group.teacherId.toString() === userData.userId?.toString()) ||
      (Array.isArray(group.teacherIds) && group.teacherIds.some((tid) => tid && tid.toString() === userData.userId?.toString())) ||
      (userData.name && group.teacherName && group.teacherName.toLowerCase() === userData.name.toLowerCase())
    );

    if (!isSender && !isAdmin && !isTeacherOfGroup) {
      throw new Error('You do not have permission to change this poll status.');
    }

    message.pollData.closed = Boolean(shouldClose);
    message.markModified('pollData');
    await message.save();

    const populated = await Message.findById(message._id).populate('senderId', 'name avatarUrl role email');

    try {
      broadcast(socketEvents.POLL_VOTED, populated, message.groupId);
      broadcast(socketEvents.MESSAGE_UPDATED, populated, message.groupId);
    } catch (e) {
      logger.warn('[Broadcast Error in togglePollStatus]:', e.message);
    }

    return populated;
  }

  /**
   * Mark a single message as seen/read
   */
  async markMessageAsRead(messageId, readerData = {}) {
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found.');
    }

    const readerInfo = await this.resolveUserDetails(
      readerData.userId,
      readerData.name || readerData.userName,
      readerData.avatarUrl,
      readerData.role
    );
    readerInfo.seenAt = new Date();

    const seenList = Array.isArray(message.seenBy) ? message.seenBy : [];
    const alreadySeen = seenList.some((s) => s && s.userId?.toString() === readerInfo.userId.toString());

    if (!alreadySeen) {
      seenList.push(readerInfo);
      message.seenBy = seenList;
    }

    const readByList = Array.isArray(message.readBy) ? message.readBy : [];
    if (!readByList.some((r) => r?.toString() === readerInfo.userId.toString())) {
      readByList.push(readerInfo.userId);
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
      logger.warn('[Broadcast Error in markMessageAsRead]:', e.message);
    }

    return {
      messageId: message._id,
      seenByCount: message.seenBy.length,
      reader: readerInfo,
    };
  }

  /**
   * Mark all unread messages in a group as seen/read
   */
  async markGroupMessagesAsRead(groupId, readerData = {}) {
    const readerInfo = await this.resolveUserDetails(
      readerData.userId,
      readerData.name || readerData.userName,
      readerData.avatarUrl,
      readerData.role
    );
    readerInfo.seenAt = new Date();

    const userIdStr = readerInfo.userId.toString();
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
        { 'seenBy.userId': { $nin: [userIdStr] } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(300);

    if (messages.length > 0) {
      const msgIds = messages.map((m) => m._id);

      // Remove any prior stale entry for this user to avoid duplicates in seenBy
      await Message.updateMany(
        { _id: { $in: msgIds } },
        {
          $pull: { seenBy: { userId: userIdStr } },
        }
      );

      // Atomically add to readBy and append readerInfo
      await Message.updateMany(
        { _id: { $in: msgIds } },
        {
          $addToSet: {
            readBy: { $each: userObjIds },
          },
          $push: {
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
        broadcast('group_updated', { groupId, unreadCount: 0 });
      } catch (e) {
        logger.warn('[Broadcast Error in markGroupMessagesAsRead]:', e.message);
      }
    }

    return { markedCount: messages.length, reader: readerInfo };
  }

  /**
   * Get detailed read receipts breakdown for a message
   */
  async getMessageReadReceipts(messageId) {
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found.');
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
      Group.findById(message.groupId).select('title name members teacherId studentIds').lean().catch(() => null),
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

    const teacherCount = Array.isArray(group?.teacherIds) && group.teacherIds.length > 0 ? group.teacherIds.length : (group?.teacherId ? 1 : 0);
    const groupMemberCount = (group?.studentIds?.length || 0) + teacherCount || allSeen.length;

    return {
      messageId: message._id,
      sentAt: message.createdAt,
      text: message.text,
      type: message.type,
      totalSeenCount: allSeen.length,
      groupMemberCount: Math.max(groupMemberCount, allSeen.length),
      teachers: teachersSeen,
      students: studentsSeen,
      allSeen,
    };
  }

  /**
   * Edit message text
   */
  async editMessage(messageId, newText, userData = {}) {
    if (!newText || !newText.trim()) {
      throw new Error('Message text cannot be empty.');
    }

    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found.');
    }

    const group = await Group.findById(message.groupId);
    const isSender = message.senderId && message.senderId.toString() === userData.userId?.toString();
    const isAdmin = ['ADMIN', 'MANAGER'].includes(userData.role);
    const isTeacherOfGroup = group && (
      (group.teacherId && group.teacherId.toString() === userData.userId?.toString()) ||
      (Array.isArray(group.teacherIds) && group.teacherIds.some((tid) => tid && tid.toString() === userData.userId?.toString())) ||
      (userData.name && group.teacherName && group.teacherName.toLowerCase() === userData.name.toLowerCase())
    );

    if (!isSender && !isAdmin && !isTeacherOfGroup) {
      throw new Error('You can only edit your own messages.');
    }

    message.text = newText.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    const populated = await Message.findById(messageId).populate('senderId', 'name avatarUrl role email');

    try {
      broadcast(socketEvents.MESSAGE_UPDATED, populated, message.groupId);
    } catch (e) {
      logger.warn('[Broadcast Error in editMessage]:', e.message);
    }

    return populated;
  }

  /**
   * Delete message (Delete for Everyone or Delete for Me)
   */
  async deleteMessage(messageId, userData = {}, forEveryone = true) {
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found.');
    }

    const group = await Group.findById(message.groupId);
    const isSender = message.senderId && message.senderId.toString() === userData.userId?.toString();
    const isAdmin = ['ADMIN', 'MANAGER'].includes(userData.role);
    const isTeacherOfGroup = group && (
      (group.teacherId && group.teacherId.toString() === userData.userId?.toString()) ||
      (Array.isArray(group.teacherIds) && group.teacherIds.some((tid) => tid && tid.toString() === userData.userId?.toString())) ||
      (userData.name && group.teacherName && group.teacherName.toLowerCase() === userData.name.toLowerCase())
    );

    if (forEveryone) {
      if (!isSender && !isAdmin && !isTeacherOfGroup) {
        throw new Error('You do not have permission to delete this message for everyone.');
      }

      const groupId = message.groupId;
      await Message.findByIdAndDelete(messageId);

      try {
        broadcast('message_deleted', { messageId, groupId }, groupId);
      } catch (e) {
        logger.warn('[Broadcast Error in deleteMessage]:', e.message);
      }

      return { messageId, groupId, forEveryone: true };
    } else {
      // Delete for Me
      const uIdStr = (userData.userId || '').toString();
      if (!message.deletedFor) message.deletedFor = [];
      if (!message.deletedFor.includes(uIdStr)) {
        message.deletedFor.push(uIdStr);
        await message.save();
      }

      return { messageId, groupId: message.groupId, forEveryone: false };
    }
  }

  /**
   * Toggle emoji reaction on message
   */
  async toggleReaction(messageId, emoji, userData = {}) {
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found.');
    }

    const userId = (userData.userId || 'dev_user').toString();
    const userName = userData.name || userData.userName || 'Member';

    if (!Array.isArray(message.reactions)) {
      message.reactions = [];
    }

    const existingIdx = message.reactions.findIndex((r) => r.userId === userId && r.emoji === emoji);
    if (existingIdx !== -1) {
      // Toggle off if already clicked
      message.reactions.splice(existingIdx, 1);
    } else {
      // Replace existing reaction from this user with new emoji
      message.reactions = message.reactions.filter((r) => r.userId !== userId);
      message.reactions.push({ userId, emoji, userName });
    }

    await message.save();

    try {
      broadcast('message_reaction', { messageId, reactions: message.reactions, groupId: message.groupId }, message.groupId);
    } catch (e) {
      logger.warn('[Broadcast Error in toggleReaction]:', e.message);
    }

    return message;
  }

  /**
   * Toggle pin state on message
   */
  async togglePin(messageId, userData = {}) {
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found.');
    }

    const group = await Group.findById(message.groupId);
    const isSender = message.senderId && message.senderId.toString() === userData.userId?.toString();
    const isAdmin = ['ADMIN', 'MANAGER'].includes(userData.role);
    const isTeacherOfGroup = group && (
      (group.teacherId && group.teacherId.toString() === userData.userId?.toString()) ||
      (Array.isArray(group.teacherIds) && group.teacherIds.some((tid) => tid && tid.toString() === userData.userId?.toString())) ||
      (userData.name && group.teacherName && group.teacherName.toLowerCase() === userData.name.toLowerCase())
    );

    if (!isSender && !isAdmin && !isTeacherOfGroup) {
      throw new Error('Only faculty, admin, or message sender can pin messages in this batch.');
    }

    message.isPinned = !message.isPinned;
    message.pinnedAt = message.isPinned ? new Date() : null;
    message.pinnedBy = message.isPinned ? (userData.name || 'Admin') : '';
    await message.save();

    try {
      broadcast('message_pinned', { messageId, isPinned: message.isPinned, groupId: message.groupId }, message.groupId);
    } catch (e) {
      logger.warn('[Broadcast Error in togglePin]:', e.message);
    }

    return message;
  }

  /**
   * Get all pinned messages in a group
   */
  async getPinnedMessages(groupId, userId = '') {
    const filter = { groupId, isPinned: true, isDeleted: { $ne: true } };
    if (userId) {
      filter.deletedFor = { $nin: [userId.toString()] };
    }

    const pinnedMessages = await Message.find(filter)
      .populate('senderId', 'name avatarUrl role email')
      .sort({ pinnedAt: -1, createdAt: -1 });

    return pinnedMessages;
  }

  /**
   * Get group media, documents, and voice notes
   */
  async getGroupMedia(groupId, type = 'ALL', userId = '') {
    const filter = { groupId, isDeleted: { $ne: true } };
    if (userId) {
      filter.deletedFor = { $nin: [userId.toString()] };
    }

    if (type.toUpperCase() === 'IMAGES') {
      filter.type = 'IMAGE';
    } else if (type.toUpperCase() === 'DOCUMENTS') {
      filter.type = { $in: ['DOCUMENT', 'FILE'] };
    } else if (type.toUpperCase() === 'AUDIO') {
      filter.type = { $in: ['VOICE', 'AUDIO'] };
    } else {
      filter.type = { $in: ['IMAGE', 'DOCUMENT', 'FILE', 'VOICE', 'AUDIO'] };
    }

    const messages = await Message.find(filter)
      .populate('senderId', 'name avatarUrl role')
      .sort({ createdAt: -1 });

    const images = [];
    const documents = [];
    const audio = [];

    messages.forEach((m) => {
      const t = m.type.toUpperCase();
      const meta = m.metadata || {};
      const fileUrl = meta.fileUrl || meta.url || meta.imageUrl || meta.audioUrl || (m.attachments?.[0]?.url);
      const item = {
        messageId: m._id,
        senderName: m.senderName,
        sentAt: m.createdAt,
        type: t,
        url: fileUrl,
        fileName: meta.fileName || m.attachments?.[0]?.fileName || 'File',
        fileSize: meta.fileSize || m.attachments?.[0]?.fileSize || '',
        duration: meta.duration || '',
      };

      if (t === 'IMAGE') {
        if (Array.isArray(m.attachments) && m.attachments.length > 0) {
          m.attachments.forEach((att, attIdx) => {
            if (att && att.url) {
              images.push({
                messageId: m._id,
                senderName: m.senderName,
                sentAt: m.createdAt,
                type: 'IMAGE',
                url: att.url,
                fileName: att.fileName || `Photo ${attIdx + 1}`,
                fileSize: att.fileSize || '',
              });
            }
          });
        } else if (fileUrl) {
          images.push(item);
        }
      } else if (t === 'VOICE' || t === 'AUDIO') {
        audio.push(item);
      } else {
        documents.push(item);
      }
    });

    return {
      groupId,
      totalCount: messages.length,
      images,
      documents,
      audio,
    };
  }

  /**
   * Search messages within a group or globally across user's batches
   */
  async searchMessages(query, groupId = null, userId = null) {
    if (!query || !query.trim()) return [];

    const filter = {
      isDeleted: { $ne: true },
      $or: [
        { text: { $regex: query.trim(), $options: 'i' } },
        { senderName: { $regex: query.trim(), $options: 'i' } },
        { 'attachments.fileName': { $regex: query.trim(), $options: 'i' } },
        { 'metadata.fileName': { $regex: query.trim(), $options: 'i' } },
      ],
    };

    if (groupId) {
      filter.groupId = groupId;
    } else if (userId) {
      // Find all groups user belongs to
      const groups = await Group.find({
        $or: [
          { studentIds: userId },
          { teacherId: userId },
          { members: userId },
        ],
      }).select('_id');
      const gIds = groups.map((g) => g._id);
      filter.groupId = { $in: gIds };
    }

    if (userId) {
      filter.deletedFor = { $nin: [userId.toString()] };
    }

    const results = await Message.find(filter)
      .populate('groupId', 'title code avatar')
      .populate('senderId', 'name avatarUrl role')
      .sort({ createdAt: -1 })
      .limit(50);

    return results;
  }

  /**
   * Forward a message to one or multiple groups
   */
  async forwardMessage(messageId, targetGroupIds = [], senderContext = {}) {
    const original = await Message.findById(messageId);
    if (!original) {
      throw new Error('Original message to forward was not found.');
    }

    if (!Array.isArray(targetGroupIds) || targetGroupIds.length === 0) {
      throw new Error('At least one target group ID is required for forwarding.');
    }

    // Determine sender identity and role
    let senderRole = (senderContext.role || 'STUDENT').toUpperCase();
    const senderId = senderContext.userId;
    if (senderId && mongoose.Types.ObjectId.isValid(senderId)) {
      const resolvedUser = await Student.findById(senderId).select('role').lean().catch(() => null)
        || await Teacher.findById(senderId).select('role').lean().catch(() => null)
        || await User.findById(senderId).select('role').lean().catch(() => null);
      if (resolvedUser?.role) {
        senderRole = resolvedUser.role.toUpperCase();
      }
    }

    const isSuperAdmin = ['ADMIN', 'MANAGER'].includes(senderRole);
    const forwardedMessages = [];
    const blockedRestrictedGroups = [];

    for (const gid of targetGroupIds) {
      try {
        const targetGroup = await Group.findById(gid).select('chatSettings title name');
        if (!targetGroup) {
          logger.warn(`[Forward] Target group ${gid} not found.`);
          continue;
        }

        // Strict Check: Block forwarding if group messaging is disabled by administrator
        if (targetGroup.chatSettings && targetGroup.chatSettings.chatEnabled === false && !isSuperAdmin) {
          logger.warn(`[Forward Blocked]: Cannot forward to restricted group ${gid} (${targetGroup.name || targetGroup.title}). chatEnabled is false.`);
          blockedRestrictedGroups.push(targetGroup.name || targetGroup.title || gid);
          continue;
        }

        const payload = {
          text: original.text,
          type: original.type,
          attachments: original.attachments,
          metadata: {
            ...original.metadata,
            originalMessageId: original._id,
            isForwarded: true,
          },
          pollData: original.pollData,
          isForwarded: true,
        };

        const sent = await this.createMessage(gid, payload, senderContext);
        forwardedMessages.push(sent);
      } catch (err) {
        logger.warn(`[Forward Error to group ${gid}]:`, err.message);
      }
    }

    if (forwardedMessages.length === 0 && blockedRestrictedGroups.length > 0) {
      throw new Error(
        `Messaging is disabled by administrator for the selected batch${blockedRestrictedGroups.length > 1 ? 'es' : ''}: ${blockedRestrictedGroups.join(', ')}.`
      );
    }

    return forwardedMessages;
  }

  /**
   * Clear all messages in a group
   */
  async clearGroupChat(groupId, userData = {}, forEveryone = false) {
    const group = await Group.findById(groupId);
    if (!group) throw new Error('Group not found.');

    const isAdmin = ['ADMIN', 'MANAGER'].includes(userData.role);
    const isTeacherOfGroup = group && (
      (group.teacherId && group.teacherId.toString() === userData.userId?.toString()) ||
      (Array.isArray(group.teacherIds) && group.teacherIds.some((tid) => tid && tid.toString() === userData.userId?.toString())) ||
      (userData.name && group.teacherName && group.teacherName.toLowerCase() === userData.name.toLowerCase())
    );

    if (forEveryone) {
      if (!isAdmin && !isTeacherOfGroup) {
        throw new Error('Only faculty or administrators can clear group chat for everyone.');
      }
      await Message.deleteMany({ groupId });
      try {
        broadcast('chat_cleared', { groupId, clearedBy: userData.name || 'Admin' }, groupId);
        broadcast('group_updated', { groupId });
      } catch (e) {
        logger.warn('[Broadcast Error in clearGroupChat]:', e.message);
      }
      return { groupId, clearedForEveryone: true };
    } else {
      const uIdStr = (userData.userId || '').toString();
      if (uIdStr) {
        await Message.updateMany(
          { groupId },
          { $addToSet: { deletedFor: uIdStr } }
        );
      }
      return { groupId, clearedForEveryone: false };
    }
  }

  /**
   * Post an automated system message into group chat
   */
  async sendSystemMessage(groupId, text, metadata = {}) {
    try {
      const msg = await Message.create({
        groupId,
        senderName: 'System',
        text,
        type: 'SYSTEM',
        metadata: {
          ...metadata,
          isSystem: true,
        },
      });

      try {
        broadcast(socketEvents.NEW_MESSAGE, msg, groupId);
      } catch (_) {}

      return msg;
    } catch (e) {
      logger.warn('[ChatService.sendSystemMessage Error]:', e.message);
      return null;
    }
  }

  /**
   * Schedule a message for future automated delivery
   */
  async scheduleMessage(groupId, messageData, senderContext = {}) {
    const {
      text = '',
      scheduledFor,
      attachments = [],
      pollData,
      metadata = {},
      mentions = [],
    } = messageData;

    if (!scheduledFor) {
      throw new Error('scheduledFor date-time is required.');
    }

    const scheduledDate = new Date(scheduledFor);
    if (isNaN(scheduledDate.getTime())) {
      throw new Error('Invalid scheduledFor date-time format.');
    }

    const group = await Group.findById(groupId);
    if (!group) {
      throw new Error('Batch group not found.');
    }

    const senderRole = (messageData.role || senderContext.role || 'STUDENT').toUpperCase();
    const isPrivileged = ['ADMIN', 'MANAGER', 'TEACHER'].includes(senderRole);
    if (group.chatSettings && group.chatSettings.chatEnabled === false && !isPrivileged) {
      throw new Error('Messaging is currently disabled by administrator for this batch.');
    }

    let senderId = messageData.senderId || senderContext.userId;
    let senderName = messageData.senderName || senderContext.name;
    let senderAvatar = messageData.avatarUrl || messageData.senderAvatar || senderContext.avatarUrl;

    const userDetails = await this.resolveUserDetails(senderId, senderName, senderAvatar, senderRole);
    senderName = senderName || userDetails.name || 'Member';
    senderAvatar = senderAvatar || userDetails.avatarUrl || '';

    let type = (messageData.type || 'TEXT').toString().toUpperCase();
    if (type === 'VOICE' || type === 'AUDIO') type = 'VOICE';
    if (type === 'DOC' || type === 'PDF') type = 'DOCUMENT';
    if (type === 'VID' || type === 'MOV' || type === 'MP4') type = 'VIDEO';

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

    let cleanMentions = [];
    if (Array.isArray(mentions)) {
      cleanMentions = mentions
        .filter((m) => m && (m.userId || m.name || m.id))
        .map((m) => ({
          userId: (m.userId || m.id || '').toString(),
          name: (m.name || '').toString().trim(),
        }));
    }

    const scheduledMsg = await ScheduledMessage.create({
      groupId,
      senderId: senderId && mongoose.Types.ObjectId.isValid(senderId) ? senderId : null,
      senderName,
      senderAvatar,
      senderRole,
      text,
      type,
      attachments: cleanAttachments,
      metadata,
      pollData: pollData || null,
      mentions: cleanMentions,
      scheduledFor: scheduledDate,
      status: 'PENDING',
    });

    try {
      broadcast(socketEvents.SCHEDULED_MESSAGES_UPDATED, { groupId, action: 'CREATED', scheduledMsg }, groupId);
    } catch (_) {}

    return scheduledMsg;
  }

  /**
   * Fetch scheduled messages for a group
   */
  async getScheduledMessages(groupId, options = {}) {
    const { status = 'PENDING', userId } = options;
    const filter = { groupId };
    if (status && status !== 'ALL') {
      filter.status = status.toUpperCase();
    }
    if (userId) {
      filter.senderId = userId;
    }

    return ScheduledMessage.find(filter)
      .sort({ scheduledFor: 1 })
      .lean();
  }

  /**
   * Cancel a pending scheduled message
   */
  async cancelScheduledMessage(scheduledId, userId, role = 'STUDENT') {
    const item = await ScheduledMessage.findById(scheduledId);
    if (!item) {
      throw new Error('Scheduled message not found.');
    }
    if (item.status !== 'PENDING') {
      throw new Error(`Cannot cancel a message that is already ${item.status.toLowerCase()}.`);
    }

    const isPrivileged = ['ADMIN', 'MANAGER', 'TEACHER'].includes((role || '').toUpperCase());
    if (!isPrivileged && userId && item.senderId && item.senderId.toString() !== userId.toString()) {
      throw new Error('Unauthorized to cancel this scheduled message.');
    }

    item.status = 'CANCELLED';
    await item.save();

    try {
      broadcast(socketEvents.SCHEDULED_MESSAGES_UPDATED, { groupId: item.groupId, action: 'CANCELLED', scheduledId }, item.groupId);
    } catch (_) {}

    return item;
  }

  /**
   * Automated Background Dispatcher: checks and delivers due scheduled messages
   */
  async dispatchDueScheduledMessages() {
    const now = new Date();
    const dueItems = await ScheduledMessage.find({
      status: 'PENDING',
      scheduledFor: { $lte: now },
    })
      .sort({ scheduledFor: 1 })
      .limit(30);

    if (!dueItems || dueItems.length === 0) {
      return 0;
    }

    let dispatchedCount = 0;

    for (const item of dueItems) {
      try {
        const locked = await ScheduledMessage.findOneAndUpdate(
          { _id: item._id, status: 'PENDING' },
          { status: 'DISPATCHING' },
          { new: true }
        );
        if (!locked) continue;

        const createdMsg = await this.createMessage(
          locked.groupId,
          {
            text: locked.text,
            type: locked.type,
            attachments: locked.attachments,
            metadata: {
              ...(locked.metadata || {}),
              isScheduled: true,
              scheduledMessageId: locked._id.toString(),
            },
            pollData: locked.pollData,
            mentions: locked.mentions,
          },
          {
            userId: locked.senderId,
            name: locked.senderName,
            avatarUrl: locked.senderAvatar,
            role: locked.senderRole,
          }
        );

        locked.status = 'SENT';
        locked.sentAt = new Date();
        locked.dispatchedMessageId = createdMsg._id;
        await locked.save();

        dispatchedCount++;

        try {
          broadcast(socketEvents.SCHEDULED_MESSAGE_SENT, { groupId: locked.groupId, message: createdMsg }, locked.groupId);
          broadcast(socketEvents.SCHEDULED_MESSAGES_UPDATED, { groupId: locked.groupId, action: 'SENT', scheduledId: locked._id }, locked.groupId);
        } catch (_) {}
      } catch (err) {
        logger.error(`[Dispatch Scheduled Error for ${item._id}]: ${err.message}`);
        await ScheduledMessage.findByIdAndUpdate(item._id, {
          status: 'FAILED',
          error: err.message,
        }).catch(() => {});
      }
    }

    return dispatchedCount;
  }
}

module.exports = new ChatService();
