const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const chatService = require('../services/chat.service');
const Message = require('../models/Message');
const Group = require('../models/Group');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const logger = require('../utils/logger');

/**
 * Fetch messages for a specific group
 */
const getMessages = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const {
      page = 1,
      limit = 100,
      search = '',
      type = '',
      pinned = false,
    } = req.query;

    const userId = req.user?.userId;

    const result = await chatService.fetchHistory(groupId, {
      page,
      limit,
      search,
      type,
      pinned,
      userId,
    });

    return successResponse(res, {
      messages: result.messages,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Send a new message to a group
 */
const sendMessage = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const senderContext = {
      userId: req.user?.userId || req.body.senderId,
      name: req.user?.name || req.body.senderName,
      avatarUrl: req.user?.avatarUrl || req.body.avatarUrl || req.body.senderAvatar,
      role: req.user?.role || req.body.role || 'STUDENT',
    };

    const message = await chatService.createMessage(groupId, req.body, senderContext);
    return successResponse(res, { message }, 'Message sent.', statusCodes.CREATED);
  } catch (err) {
    if (err.message && (err.message.includes('disabled') || err.message.includes('not found'))) {
      const code = err.message.includes('not found') ? statusCodes.NOT_FOUND : statusCodes.FORBIDDEN;
      return errorResponse(res, err.message, code);
    }
    next(err);
  }
};

/**
 * Vote on a Poll Message
 */
const votePoll = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { optionIndex = 0 } = req.body;
    const voterData = {
      userId: req.body.userId || req.user?.userId || 'dev_student_id',
      name: req.body.name || req.body.userName || req.user?.name || '',
      avatarUrl: req.body.avatarUrl || req.user?.avatarUrl || '',
      role: (req.body.role || req.user?.role || 'STUDENT').toUpperCase(),
    };

    const message = await chatService.votePoll(messageId, optionIndex, voterData);
    return successResponse(res, { message }, 'Vote recorded successfully.');
  } catch (err) {
    if (err.message && (err.message.includes('not found') || err.message.includes('closed') || err.message.includes('Invalid'))) {
      const code = err.message.includes('not found') ? statusCodes.NOT_FOUND : statusCodes.BAD_REQUEST;
      return errorResponse(res, err.message, code);
    }
    next(err);
  }
};

/**
 * Close or Reopen a Poll
 */
const togglePollStatus = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { closed = true } = req.body;
    const userData = {
      userId: req.user?.userId || req.body.userId,
      name: req.user?.name || req.body.userName,
      role: (req.user?.role || req.body.role || 'STUDENT').toUpperCase(),
    };

    const message = await chatService.togglePollStatus(messageId, closed, userData);
    return successResponse(res, { message }, `Poll ${closed ? 'closed' : 'reopened'} successfully.`);
  } catch (err) {
    if (err.message && err.message.includes('permission')) {
      return errorResponse(res, err.message, statusCodes.FORBIDDEN);
    }
    if (err.message && err.message.includes('not found')) {
      return errorResponse(res, err.message, statusCodes.NOT_FOUND);
    }
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
    const readerData = {
      userId: req.body.userId || req.user?.userId || 'dev_student_id',
      name: req.body.name || req.body.userName || req.user?.name || '',
      avatarUrl: req.body.avatarUrl || req.user?.avatarUrl || '',
      role: (req.body.role || req.user?.role || 'STUDENT').toUpperCase(),
    };

    const result = await chatService.markMessageAsRead(messageId, readerData);
    return successResponse(res, result, 'Message marked as seen.');
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      return errorResponse(res, err.message, statusCodes.NOT_FOUND);
    }
    next(err);
  }
};

/**
 * Mark all messages in a group as seen / read by user
 */
const markGroupMessagesAsRead = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const readerData = {
      userId: req.body.userId || req.user?.userId || 'dev_student_id',
      name: req.body.name || req.body.userName || req.user?.name || '',
      avatarUrl: req.body.avatarUrl || req.user?.avatarUrl || '',
      role: (req.body.role || req.user?.role || 'STUDENT').toUpperCase(),
    };

    const result = await chatService.markGroupMessagesAsRead(groupId, readerData);
    return successResponse(res, result, 'Messages marked as seen.');
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
    const result = await chatService.getMessageReadReceipts(messageId);
    return successResponse(res, result);
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      return errorResponse(res, err.message, statusCodes.NOT_FOUND);
    }
    next(err);
  }
};

/**
 * Upload audio, image, video, or document
 */
const resolveUploadCategory = (fileName = '', fileType = '') => {
  const ext = path.extname(fileName).toLowerCase();
  const mime = (fileType || '').toLowerCase();

  if (
    mime.startsWith('audio/') ||
    ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.opus', '.flac', '.wma', '.amr'].includes(ext) ||
    fileName.toLowerCase().includes('voice_')
  ) {
    return 'audio';
  }

  if (
    mime.startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)
  ) {
    return 'images';
  }

  if (
    mime.startsWith('video/') ||
    ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp'].includes(ext)
  ) {
    return 'videos';
  }

  return 'documents';
};

const saveFileBuffer = (fileData, fileName = `media_${Date.now()}.jpg`, fileType = '', req) => {
  const cleanBase64 = fileData.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const safeName = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const uploadsDir = path.join(__dirname, '../../uploads');

  const category = resolveUploadCategory(fileName, fileType);
  const categoryDir = path.join(uploadsDir, category);

  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }

  const filePath = path.join(categoryDir, safeName);
  fs.writeFileSync(filePath, buffer);

  let host = req.get('host') || 'localhost:5000';
  if (process.env.SERVER_HOST) {
    host = process.env.SERVER_HOST.replace(/^https?:\/\//, '');
  }
  const protocol = req.protocol || 'http';
  const fileUrl = `${protocol}://${host}/uploads/${category}/${safeName}`;

  return {
    url: fileUrl,
    category,
    fileName: safeName,
    fileSize: `${(buffer.length / 1024).toFixed(1)} KB`,
    fileType: fileType || (category === 'audio' ? 'audio/m4a' : (category === 'videos' ? 'video/mp4' : (category === 'documents' ? 'application/pdf' : 'image/jpeg'))),
  };
};

const uploadMultipleFiles = async (req, res, next) => {
  try {
    const files = req.body.files;
    if (!Array.isArray(files) || files.length === 0) {
      return errorResponse(res, 'No files array provided.', statusCodes.BAD_REQUEST);
    }

    const uploaded = [];
    for (const f of files) {
      if (f && f.fileData) {
        const item = saveFileBuffer(f.fileData, f.fileName, f.fileType, req);
        uploaded.push(item);
      }
    }

    return successResponse(
      res,
      { files: uploaded, count: uploaded.length },
      `${uploaded.length} files uploaded successfully.`,
      statusCodes.CREATED
    );
  } catch (err) {
    next(err);
  }
};

const uploadFile = async (req, res, next) => {
  try {
    if (Array.isArray(req.body.files) && req.body.files.length > 0) {
      return uploadMultipleFiles(req, res, next);
    }

    const { fileData, fileName = `media_${Date.now()}.jpg`, fileType } = req.body;
    if (!fileData) {
      return errorResponse(res, 'No file data provided.', statusCodes.BAD_REQUEST);
    }

    const fileMeta = saveFileBuffer(fileData, fileName, fileType, req);
    return successResponse(res, fileMeta, 'File uploaded successfully.', statusCodes.CREATED);
  } catch (err) {
    next(err);
  }
};

/**
 * Edit message text
 */
const editMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { text } = req.body;
    const userData = {
      userId: req.user?.userId,
      name: req.user?.name,
      role: req.user?.role || 'STUDENT',
    };

    const message = await chatService.editMessage(messageId, text, userData);
    return successResponse(res, { message }, 'Message updated successfully.');
  } catch (err) {
    if (err.message && err.message.includes('only edit your own')) {
      return errorResponse(res, err.message, statusCodes.FORBIDDEN);
    }
    if (err.message && err.message.includes('not found')) {
      return errorResponse(res, err.message, statusCodes.NOT_FOUND);
    }
    if (err.message && err.message.includes('empty')) {
      return errorResponse(res, err.message, statusCodes.BAD_REQUEST);
    }
    next(err);
  }
};

/**
 * Delete message (Delete for Everyone or Delete for Me)
 */
const deleteMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const forEveryone = req.query.forEveryone !== 'false' && req.body.forEveryone !== false;
    const userData = {
      userId: req.user?.userId,
      name: req.user?.name,
      role: req.user?.role || 'STUDENT',
    };

    const result = await chatService.deleteMessage(messageId, userData, forEveryone);
    return successResponse(res, result, 'Message deleted successfully.');
  } catch (err) {
    if (err.message && err.message.includes('permission')) {
      return errorResponse(res, err.message, statusCodes.FORBIDDEN);
    }
    if (err.message && err.message.includes('not found')) {
      return errorResponse(res, err.message, statusCodes.NOT_FOUND);
    }
    next(err);
  }
};

/**
 * Toggle emoji reaction on message
 */
const reactToMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userData = {
      userId: req.user?.userId || req.body.userId || 'dev_user',
      name: req.user?.name || req.body.userName || 'Member',
    };

    const message = await chatService.toggleReaction(messageId, emoji, userData);
    return successResponse(res, { message }, 'Reaction updated.');
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      return errorResponse(res, err.message, statusCodes.NOT_FOUND);
    }
    next(err);
  }
};

/**
 * Toggle pin state on message
 */
const pinMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userData = {
      userId: req.user?.userId || req.body.userId,
      name: req.user?.name || req.body.userName,
      role: req.user?.role || req.body.role || 'STUDENT',
    };

    const message = await chatService.togglePin(messageId, userData);
    return successResponse(res, { messageId, isPinned: message.isPinned }, 'Message pin toggled.');
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      return errorResponse(res, err.message, statusCodes.NOT_FOUND);
    }
    if (err.message && err.message.includes('faculty')) {
      return errorResponse(res, err.message, statusCodes.FORBIDDEN);
    }
    next(err);
  }
};

/**
 * Get all pinned messages in a group
 */
const getPinnedMessages = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const userId = req.user?.userId;
    const messages = await chatService.getPinnedMessages(groupId, userId);
    return successResponse(res, { messages, count: messages.length });
  } catch (err) {
    next(err);
  }
};

/**
 * Get shared media, documents, and voice notes in a group
 */
const getGroupMedia = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { type = 'ALL' } = req.query;
    const userId = req.user?.userId;

    const media = await chatService.getGroupMedia(groupId, type, userId);
    return successResponse(res, media);
  } catch (err) {
    next(err);
  }
};

/**
 * Search messages across a group or globally across user's groups
 */
const searchMessages = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { q = '', query = '' } = req.query;
    const searchQuery = q || query;
    const userId = req.user?.userId;

    const messages = await chatService.searchMessages(searchQuery, groupId || null, userId);
    return successResponse(res, { messages, count: messages.length });
  } catch (err) {
    next(err);
  }
};

/**
 * Forward a message to one or more groups
 */
const forwardMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { targetGroupIds = [] } = req.body;
    const senderContext = {
      userId: req.user?.userId || req.body.senderId,
      name: req.user?.name || req.body.senderName,
      avatarUrl: req.user?.avatarUrl || req.body.avatarUrl || req.body.senderAvatar,
      role: req.user?.role || req.body.role || 'STUDENT',
    };

    const messages = await chatService.forwardMessage(messageId, targetGroupIds, senderContext);
    return successResponse(res, { forwardedMessages: messages, count: messages.length }, 'Message forwarded successfully.');
  } catch (err) {
    if (err.message && (err.message.includes('not found') || err.message.includes('required') || err.message.includes('disabled by administrator') || err.message.includes('restricted'))) {
      return errorResponse(res, err.message, statusCodes.BAD_REQUEST);
    }
    next(err);
  }
};

/**
 * Clear all messages in a group
 */
const clearGroupChat = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const forEveryone = req.query.forEveryone === 'true' || req.body.forEveryone === true;
    const userData = {
      userId: req.user?.userId,
      name: req.user?.name,
      role: req.user?.role || 'STUDENT',
    };

    const result = await chatService.clearGroupChat(groupId, userData, forEveryone);
    return successResponse(res, result, `Chat cleared ${forEveryone ? 'for everyone' : 'for your account'}.`);
  } catch (err) {
    if (err.message && err.message.includes('permission')) {
      return errorResponse(res, err.message, statusCodes.FORBIDDEN);
    }
    next(err);
  }
};

/**
 * Schedule a Message for future automated delivery
 */
const scheduleMessage = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const senderContext = {
      userId: req.user?.userId || req.body.senderId,
      name: req.user?.name || req.body.senderName,
      avatarUrl: req.user?.avatarUrl || req.body.avatarUrl || req.body.senderAvatar,
      role: req.user?.role || req.body.role || 'STUDENT',
    };

    const scheduledMessage = await chatService.scheduleMessage(groupId, req.body, senderContext);
    return successResponse(res, { scheduledMessage }, 'Message scheduled successfully.', statusCodes.CREATED);
  } catch (err) {
    if (err.message && (err.message.includes('required') || err.message.includes('format'))) {
      return errorResponse(res, err.message, statusCodes.BAD_REQUEST);
    }
    if (err.message && (err.message.includes('disabled') || err.message.includes('not found'))) {
      const code = err.message.includes('not found') ? statusCodes.NOT_FOUND : statusCodes.FORBIDDEN;
      return errorResponse(res, err.message, code);
    }
    next(err);
  }
};

/**
 * Fetch pending or history scheduled messages
 */
const getScheduledMessages = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { status = 'PENDING' } = req.query;
    const userId = req.user?.role === 'STUDENT' ? (req.user?.userId || req.query.userId) : null;

    const scheduledMessages = await chatService.getScheduledMessages(groupId, { status, userId });
    return successResponse(res, { scheduledMessages, count: scheduledMessages.length }, 'Scheduled messages retrieved.');
  } catch (err) {
    next(err);
  }
};

/**
 * Cancel a pending scheduled message
 */
const cancelScheduledMessage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.body.userId;
    const role = req.user?.role || req.body.role || 'STUDENT';

    const cancelled = await chatService.cancelScheduledMessage(id, userId, role);
    return successResponse(res, { cancelled }, 'Scheduled message cancelled.');
  } catch (err) {
    if (err.message && (err.message.includes('not found') || err.message.includes('Unauthorized') || err.message.includes('Cannot cancel'))) {
      const code = err.message.includes('not found') ? statusCodes.NOT_FOUND : (err.message.includes('Unauthorized') ? statusCodes.FORBIDDEN : statusCodes.BAD_REQUEST);
      return errorResponse(res, err.message, code);
    }
    next(err);
  }
};

module.exports = {
  getMessages,
  sendMessage,
  scheduleMessage,
  getScheduledMessages,
  cancelScheduledMessage,
  votePoll,
  togglePollStatus,
  getPollVoters,
  markMessageAsRead,
  markGroupMessagesAsRead,
  getMessageReadReceipts,
  uploadFile,
  uploadMultipleFiles,
  editMessage,
  deleteMessage,
  reactToMessage,
  pinMessage,
  getPinnedMessages,
  getGroupMedia,
  searchMessages,
  forwardMessage,
  clearGroupChat,
};
