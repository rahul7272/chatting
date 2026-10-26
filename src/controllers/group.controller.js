const mongoose = require('mongoose');
const Group = require('../models/Group');
const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Message = require('../models/Message');
const { findAccountById } = require('../utils/userLocator');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const { ROLES } = require('../constants/roles');
const { broadcast } = require('../config/socket');
const socketEvents = require('../constants/socketEvents');

/**
 * Helper to populate teacher and students with all profile fields from Student and Teacher models
 */
const populateGroup = (query) => {
  return query
    .populate({
      path: 'teacherId',
      model: 'Teacher',
      select: 'name email phoneNumber avatar avatarUrl qualification instruments',
    })
    .populate({
      path: 'studentIds',
      model: 'Student',
      select: 'name email phoneNumber avatar avatarUrl enrolledCreditBalance studentLevel status enrollmentNo city state instruments createdAt admissionDate',
    });
};

/**
 * List groups with search, filter, and population
 */
const listGroups = async (req, res, next) => {
  try {
    const {
      search = '',
      status = 'ALL',
      level = 'ALL',
      subject = 'ALL',
      teacher = 'ALL',
      sortBy = 'createdAt',
      order = 'desc',
      page = 1,
      limit = 100,
    } = req.query;

    let filter = {};

    // Status Filter
    if (status && status !== 'ALL') {
      filter.status = status;
    }

    // Level Filter
    if (level && level !== 'ALL') {
      filter.level = level;
    }

    // Subject Filter
    if (subject && subject !== 'ALL') {
      filter.subject = subject;
    }

    // Search Query (title, code, subject, teacherName)
    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { code: { $regex: q, $options: 'i' } },
        { subject: { $regex: q, $options: 'i' } },
        { teacherName: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
      ];
    }

    // Membership filtering for student/teacher users (Admin Console passes all=true)
    const userRole = req.user?.role;
    const userId = req.user?.userId;
    const isAllRequested = req.query.all === 'true' || req.query.admin === 'true';

    if (!isAllRequested && userRole !== ROLES.ADMIN && userRole !== ROLES.MANAGER && userId) {
      filter.$and = filter.$and || [];
      const isTeacherRole =
        userRole === ROLES.TEACHER ||
        (typeof userRole === 'string' && userRole.toUpperCase() === 'TEACHER');

      if (isTeacherRole) {
        // Teacher sees only batches currently assigned to them by Admin in Admin Console
        const teacherDoc = await Teacher.findById(userId).lean();
        const teacherConditions = [
          { teacherId: userId },
        ];
        if (teacherDoc && teacherDoc.name) {
          teacherConditions.push({
            teacherName: new RegExp('^' + teacherDoc.name.trim() + '$', 'i'),
          });
        }
        filter.$and.push({ $or: teacherConditions });
      } else {
        // Student sees only batches where they are enrolled
        filter.$and.push({
          $or: [
            { studentIds: userId },
            { members: userId },
            { 'members._id': userId },
            { 'members.id': userId },
          ],
        });
      }
    }

    const sortOptions = {};
    sortOptions[sortBy] = order === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [groups, total] = await Promise.all([
      populateGroup(Group.find(filter))
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit)),
      Group.countDocuments(filter),
    ]);

    const groupIds = groups.map((g) => g._id);
    const currentUserId = req.user?.userId;

    let unreadMap = {};
    let lastMessageMap = {};

    if (groupIds.length > 0) {
      try {
        const groupObjIds = groupIds.map((id) =>
          mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id.toString()) : id
        );
        const groupIdsAll = [...groupIds, ...groupObjIds];

        const latestMsgs = await Message.aggregate([
          { $match: { groupId: { $in: groupIdsAll } } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$groupId',
              lastMessage: { $first: '$$ROOT' },
            },
          },
        ]);

        latestMsgs.forEach((lm) => {
          if (lm.lastMessage) {
            lastMessageMap[lm._id.toString()] = {
              text: lm.lastMessage.text || '',
              type: lm.lastMessage.type || 'TEXT',
              createdAt: lm.lastMessage.createdAt,
              senderName: lm.lastMessage.senderName || '',
            };
          }
        });

        if (currentUserId) {
          const currentUserIdStr = currentUserId.toString();
          const userObjIds = [currentUserIdStr];
          if (mongoose.Types.ObjectId.isValid(currentUserIdStr)) {
            userObjIds.push(new mongoose.Types.ObjectId(currentUserIdStr));
          }

          const unreadAgg = await Message.aggregate([
            {
              $match: {
                groupId: { $in: groupIdsAll },
                senderId: { $nin: userObjIds },
                readBy: { $nin: [currentUserIdStr, ...userObjIds] },
                'seenBy.userId': { $ne: currentUserIdStr },
              },
            },
            {
              $group: {
                _id: '$groupId',
                count: { $sum: 1 },
              },
            },
          ]);

          unreadAgg.forEach((u) => {
            unreadMap[u._id.toString()] = u.count || 0;
          });
        }
      } catch (e) {
        console.warn('[group.controller listGroups] Metadata error:', e.message);
      }
    }

    const groupsWithMeta = groups.map((g) => {
      const gObj = g.toObject ? g.toObject() : { ...g };
      const gIdStr = g._id.toString();
      gObj.lastMessage = lastMessageMap[gIdStr] || null;
      gObj.unreadCount = unreadMap[gIdStr] || 0;
      return gObj;
    });

    return successResponse(res, {
      groups: groupsWithMeta,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get aggregated dashboard statistics for Group Management
 */
const getGroupStats = async (req, res, next) => {
  try {
    const [allGroups, totalStudentsCount, totalTeachersCount] = await Promise.all([
      Group.find({}),
      Student.countDocuments({ status: { $ne: 'Left' } }).catch(() => 0),
      Teacher.countDocuments({ status: { $ne: 'Left' } }).catch(() => 0),
    ]);

    const totalGroups = allGroups.length;
    const activeGroups = allGroups.filter((g) => g.status === 'Active' || (g.isActive && !g.status)).length;
    const inactiveGroups = allGroups.filter((g) => g.status === 'Inactive' || g.status === 'Archived' || g.status === 'Paused').length;
    const draftGroups = allGroups.filter((g) => g.status === 'Draft').length;

    // Estimate classes scheduled for today based on daysOfWeek
    const currentDay = new Date().getDay(); // 0 = Sun, 1 = Mon ...
    const classesToday = allGroups.filter((g) => {
      if (g.status !== 'Active' && g.isActive !== true) return false;
      return g.schedule?.daysOfWeek?.includes(currentDay);
    }).length;

    return successResponse(res, {
      stats: {
        totalGroups,
        activeGroups,
        inactiveGroups,
        draftGroups,
        totalStudentsCount,
        totalTeachersCount,
        classesToday: classesToday || Math.min(activeGroups, 6),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Create a new Group / Batch
 */
const createGroup = async (req, res, next) => {
  try {
    const {
      title,
      code,
      subject,
      level = 'Beginner',
      description = '',
      status = 'Active',
      teacherId,
      teacherName = '',
      studentIds = [],
      meetUrl = 'https://meet.google.com/new',
      schedule = {},
      chatSettings = {},
    } = req.body;

    if (!title || !code || !subject) {
      return errorResponse(res, 'Group Title, Batch Code, and Subject are required.', statusCodes.BAD_REQUEST);
    }

    // Check duplicate code
    const existing = await Group.findOne({ code: code.toUpperCase().trim() });
    if (existing) {
      return errorResponse(res, `Batch Code "${code}" is already in use. Please use a unique code.`, statusCodes.CONFLICT);
    }

    let resolvedTeacherName = teacherName;
    if (teacherId) {
      const teacherDoc = (await Teacher.findById(teacherId)) || (await User.findById(teacherId));
      if (teacherDoc) resolvedTeacherName = teacherDoc.name || resolvedTeacherName;
    }

    const avatarUrl = (req.body.avatar || req.body.profilePic || req.body.avatarUrl || '').trim();

    const group = await Group.create({
      title: title.trim(),
      code: code.toUpperCase().trim(),
      subject: subject.trim(),
      level,
      description: description.trim(),
      avatar: avatarUrl,
      profilePic: avatarUrl,
      status,
      isActive: status === 'Active',
      teacherId: teacherId || null,
      teacherName: resolvedTeacherName,
      studentIds: studentIds || [],
      meetUrl: meetUrl || 'https://meet.google.com/new',
      schedule: {
        daysOfWeek: Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [],
        dayNames: Array.isArray(schedule.dayNames) ? schedule.dayNames : [],
        startTime: schedule.startTime || '05:00 PM',
        endTime: schedule.endTime || '06:00 PM',
        timezone: schedule.timezone || 'Asia/Kolkata',
        notes: schedule.notes || '',
      },
      chatSettings: {
        chatEnabled: chatSettings.chatEnabled !== undefined ? chatSettings.chatEnabled : true,
        pollsEnabled: chatSettings.pollsEnabled !== undefined ? chatSettings.pollsEnabled : true,
        mentionsEnabled: chatSettings.mentionsEnabled !== undefined ? chatSettings.mentionsEnabled : true,
        everyoneEnabled: chatSettings.everyoneEnabled !== undefined ? chatSettings.everyoneEnabled : true,
        personalChatAllowed: chatSettings.personalChatAllowed !== undefined ? chatSettings.personalChatAllowed : false,
        historyPolicy: chatSettings.historyPolicy || 'FULL',
        allowRecordings: chatSettings.allowRecordings !== undefined ? chatSettings.allowRecordings : true,
        allowNotes: chatSettings.allowNotes !== undefined ? chatSettings.allowNotes : true,
        allowAssignments: chatSettings.allowAssignments !== undefined ? chatSettings.allowAssignments : true,
        showMembers: chatSettings.showMembers !== undefined ? chatSettings.showMembers : true,
        showMemberCount: chatSettings.showMemberCount !== undefined ? chatSettings.showMemberCount : true,
      },
      activityLogs: [
        {
          action: 'Group Created',
          actorName: req.user?.name || 'Admin',
          details: `Batch "${title}" (${code}) initialized with ${studentIds.length} students.`,
          timestamp: new Date(),
        },
      ],
      teacherHistory: teacherId
        ? [
            {
              teacherId,
              teacherName: resolvedTeacherName,
              assignedAt: new Date(),
              assignedBy: req.user?.name || 'Admin',
              reason: 'Initial Batch Creator Assignment',
            },
          ]
        : [],
    });

    const populated = await populateGroup(Group.findById(group._id));

    try {
      broadcast(socketEvents.GROUP_UPDATED, populated, null);
    } catch (e) {
      console.warn('[Broadcast Error in createGroup]:', e.message);
    }

    return successResponse(res, { group: populated }, 'Group / Batch created successfully.', statusCodes.CREATED);
  } catch (err) {
    next(err);
  }
};

/**
 * Get Group by ID with full details
 */
const getGroupById = async (req, res, next) => {
  try {
    const group = await populateGroup(Group.findById(req.params.id));

    if (!group) {
      return errorResponse(res, 'Group / Batch not found.', statusCodes.NOT_FOUND);
    }
    return successResponse(res, { group });
  } catch (err) {
    next(err);
  }
};

/**
 * Update Group details
 */
const updateGroup = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    // Check code uniqueness if changing
    if (updates.code && updates.code.toUpperCase().trim() !== group.code) {
      const codeExists = await Group.findOne({
        code: updates.code.toUpperCase().trim(),
        _id: { $ne: id },
      });
      if (codeExists) {
        return errorResponse(res, `Batch Code "${updates.code}" is already in use.`, statusCodes.CONFLICT);
      }
      group.code = updates.code.toUpperCase().trim();
    }

    if (updates.title) group.title = updates.title.trim();
    if (updates.subject) group.subject = updates.subject.trim();
    if (updates.level) group.level = updates.level;
    if (updates.description !== undefined) group.description = updates.description.trim();
    if (updates.avatar !== undefined || updates.profilePic !== undefined || updates.avatarUrl !== undefined) {
      const av = (updates.avatar !== undefined ? updates.avatar : (updates.profilePic !== undefined ? updates.profilePic : updates.avatarUrl || '')).trim();
      group.avatar = av;
      group.profilePic = av;
    }
    if (updates.status) {
      group.status = updates.status;
      group.isActive = updates.status === 'Active';
    }
    if (updates.meetUrl !== undefined) group.meetUrl = updates.meetUrl.trim();
    if (updates.schedule) {
      group.schedule = {
        ...group.schedule.toObject(),
        ...updates.schedule,
      };
    }
    if (updates.chatSettings) {
      group.chatSettings = {
        ...group.chatSettings.toObject(),
        ...updates.chatSettings,
      };
    }

    // Log update activity
    group.activityLogs.unshift({
      action: 'Group Details Updated',
      actorName: req.user?.name || 'Admin',
      details: `Batch configuration and settings updated by Admin.`,
      timestamp: new Date(),
    });

    await group.save();

    const populated = await populateGroup(Group.findById(id));

    try {
      broadcast(socketEvents.GROUP_UPDATED, populated, id);
    } catch (e) {
      console.warn('[Broadcast Error in updateGroup]:', e.message);
    }

    return successResponse(res, { group: populated }, 'Group updated successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Reassign or Assign Teacher with historical tracking
 */
const assignTeacher = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { teacherId, teacherName, reason = 'Faculty reallocation' } = req.body;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const previousTeacherName = group.teacherName || 'None';

    // Mark previous teacher history record with removedAt
    if (group.teacherHistory && group.teacherHistory.length > 0) {
      const lastHistory = group.teacherHistory[group.teacherHistory.length - 1];
      if (!lastHistory.removedAt) {
        lastHistory.removedAt = new Date();
      }
    }

    // Resolve new teacher
    let resolvedName = teacherName;
    if (teacherId) {
      const teacherDoc = (await Teacher.findById(teacherId)) || (await User.findById(teacherId));
      if (teacherDoc) {
        resolvedName = teacherDoc.name || resolvedName;
      }
    }

    group.teacherId = teacherId || null;
    group.teacherName = resolvedName || '';

    if (teacherId) {
      group.teacherHistory.push({
        teacherId,
        teacherName: resolvedName,
        assignedAt: new Date(),
        assignedBy: req.user?.name || 'Admin',
        reason,
      });
    }

    group.activityLogs.unshift({
      action: 'Teacher Reassigned',
      actorName: req.user?.name || 'Admin',
      details: `Teacher changed from "${previousTeacherName}" to "${resolvedName || 'Unassigned'}". Reason: ${reason}`,
      timestamp: new Date(),
    });

    await group.save();

    const populated = await populateGroup(Group.findById(id));

    try {
      broadcast(socketEvents.GROUP_UPDATED, populated, id);
    } catch (e) {
      console.warn('[Broadcast Error in assignTeacher]:', e.message);
    }

    return successResponse(res, { group: populated }, `Teacher reassigned to ${resolvedName || 'Unassigned'}.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Add student(s) to Group
 */
const addStudents = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { studentIds = [] } = req.body;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const existingIds = (group.studentIds || []).map((s) => s.toString());
    const newIds = studentIds.filter((sid) => !existingIds.includes(sid.toString()));

    if (newIds.length === 0) {
      const populated = await populateGroup(Group.findById(id));
      return successResponse(res, { group: populated }, 'Selected students are already enrolled in this batch.');
    }

    group.studentIds.push(...newIds);

    group.activityLogs.unshift({
      action: 'Students Enrolled',
      actorName: req.user?.name || 'Admin',
      details: `Added ${newIds.length} new student(s) to the batch.`,
      timestamp: new Date(),
    });

    await group.save();

    const populated = await populateGroup(Group.findById(id));

    try {
      broadcast(socketEvents.MEMBERS_UPDATED, populated, id);
    } catch (e) {
      console.warn('[Broadcast Error in addStudents]:', e.message);
    }

    return successResponse(res, { group: populated }, `${newIds.length} student(s) added successfully.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Remove student from Group
 */
const removeStudent = async (req, res, next) => {
  try {
    const { id, studentId } = req.params;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    group.studentIds = group.studentIds.filter((s) => s.toString() !== studentId.toString());

    group.activityLogs.unshift({
      action: 'Student Removed',
      actorName: req.user?.name || 'Admin',
      details: `Student removed from the batch.`,
      timestamp: new Date(),
    });

    await group.save();

    const populated = await populateGroup(Group.findById(id));

    try {
      broadcast(socketEvents.MEMBERS_UPDATED, populated, id);
    } catch (e) {
      console.warn('[Broadcast Error in removeStudent]:', e.message);
    }

    return successResponse(res, { group: populated }, 'Student removed from batch.');
  } catch (err) {
    next(err);
  }
};

/**
 * Add a class recording
 */
const addRecording = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, topic, url, date, durationMinutes } = req.body;

    if (!title || !url) {
      return errorResponse(res, 'Recording Title and Video URL are required.', statusCodes.BAD_REQUEST);
    }

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    group.recordings.unshift({
      title: title.trim(),
      topic: topic ? topic.trim() : '',
      url: url.trim(),
      date: date || new Date().toISOString().split('T')[0],
      durationMinutes: durationMinutes || 60,
      addedBy: req.user?.name || 'Admin',
      createdAt: new Date(),
    });

    group.activityLogs.unshift({
      action: 'Recording Added',
      actorName: req.user?.name || 'Admin',
      details: `Uploaded / linked class recording: "${title}".`,
      timestamp: new Date(),
    });

    await group.save();

    try {
      broadcast(socketEvents.RECORDINGS_UPDATED, { recordings: group.recordings }, id);
    } catch (e) {
      console.warn('[Broadcast Error in addRecording]:', e.message);
    }

    return successResponse(res, { recordings: group.recordings }, 'Class recording added successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Delete a class recording
 */
const deleteRecording = async (req, res, next) => {
  try {
    const { id, recordingId } = req.params;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    group.recordings = group.recordings.filter((r) => r._id.toString() !== recordingId);
    await group.save();

    try {
      broadcast(socketEvents.RECORDINGS_UPDATED, { recordings: group.recordings }, id);
    } catch (e) {
      console.warn('[Broadcast Error in deleteRecording]:', e.message);
    }

    return successResponse(res, { recordings: group.recordings }, 'Recording deleted successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Track student/user clicking the "Watch" button on a class recording
 * POST /api/v1/groups/:id/recordings/:recordingId/watch
 */
const logRecordingWatch = async (req, res, next) => {
  try {
    const { id, recordingId } = req.params;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const recording = group.recordings.id(recordingId);
    if (!recording) {
      return errorResponse(res, 'Class recording not found.', statusCodes.NOT_FOUND);
    }

    const userId = req.user?.userId;
    let userName = req.user?.name || req.body?.userName || 'Student';
    let userEmail = req.user?.email || req.body?.userEmail || '';
    let userRole = req.user?.role || req.body?.userRole || 'STUDENT';
    let avatarUrl = req.user?.avatarUrl || req.body?.avatarUrl || '';
    let studentObjId = null;

    if (userId) {
      try {
        if (mongoose.Types.ObjectId.isValid(userId)) {
          // Fast direct lookup in Student collection first
          const student = await Student.findById(userId).select('name email alternativeEmail avatar avatarUrl').lean();
          if (student) {
            userName = student.name || userName;
            userEmail = student.email || student.alternativeEmail || userEmail;
            userRole = 'STUDENT';
            avatarUrl = student.avatar || student.avatarUrl || avatarUrl;
            studentObjId = student._id;
          } else {
            const accountInfo = await findAccountById(userId);
            if (accountInfo?.account) {
              const acc = accountInfo.account;
              userName = acc.name || userName;
              userEmail = acc.email || acc.alternativeEmail || userEmail;
              userRole = accountInfo.type || userRole;
              avatarUrl = acc.avatarUrl || acc.avatar || acc.profilePic || avatarUrl;
              if (accountInfo.type === 'STUDENT' && mongoose.Types.ObjectId.isValid(acc._id)) {
                studentObjId = acc._id;
              }
            }
          }
        }
      } catch (errUser) {
        console.warn('[logRecordingWatch] User resolve note:', errUser.message);
      }
    }

    if (!recording.viewers) {
      recording.viewers = [];
    }

    // Check if user already in viewers list
    const existingIndex = recording.viewers.findIndex((v) => {
      const matchUserId = v.userId && userId && String(v.userId) === String(userId);
      const matchEmail = v.userEmail && userEmail && v.userEmail.toLowerCase() === userEmail.toLowerCase();
      return matchUserId || matchEmail;
    });

    if (existingIndex !== -1) {
      recording.viewers[existingIndex].watchedAt = new Date();
      recording.viewers[existingIndex].watchCount = (recording.viewers[existingIndex].watchCount || 1) + 1;
      if (userName && userName !== 'Student') recording.viewers[existingIndex].userName = userName;
      if (userEmail) recording.viewers[existingIndex].userEmail = userEmail;
      if (avatarUrl) recording.viewers[existingIndex].avatarUrl = avatarUrl;
      if (studentObjId) recording.viewers[existingIndex].studentId = studentObjId;
    } else {
      recording.viewers.unshift({
        userId: userId ? String(userId) : '',
        studentId: studentObjId,
        userName,
        userEmail,
        userRole,
        avatarUrl,
        watchedAt: new Date(),
        watchCount: 1,
      });
    }

    await group.save();

    // Broadcast real-time update to Admin Panel and apps smoothly
    try {
      // 1. Dedicated recording watch log event for Admin Panel (instant live update)
      broadcast('recording_watch_logged', {
        groupId: id,
        recordingId,
        viewers: recording.viewers,
        latestViewer: recording.viewers[existingIndex !== -1 ? existingIndex : 0],
      });

      // 2. Recordings updated broadcast with isWatchEvent flag to prevent unwanted app reload
      broadcast(
        socketEvents.RECORDINGS_UPDATED,
        {
          groupId: id,
          recordings: group.recordings,
          isWatchEvent: true,
          recordingId,
          viewers: recording.viewers,
        },
        id
      );
    } catch (e) {
      console.warn('[Broadcast Error in logRecordingWatch]:', e.message);
    }

    return successResponse(
      res,
      { viewers: recording.viewers, recording },
      'Recording watch logged successfully.'
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Add a note / assignment resource
 */
const addResource = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, type = 'note', fileUrl, description, dueDate } = req.body;

    if (!title) {
      return errorResponse(res, 'Resource title is required.', statusCodes.BAD_REQUEST);
    }

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    group.resources.unshift({
      title: title.trim(),
      type,
      fileUrl: fileUrl ? fileUrl.trim() : '',
      description: description ? description.trim() : '',
      dueDate: dueDate || '',
      isPublished: true,
      addedBy: req.user?.name || 'Admin',
      createdAt: new Date(),
    });

    group.activityLogs.unshift({
      action: 'Study Resource Published',
      actorName: req.user?.name || 'Admin',
      details: `Published ${type}: "${title}".`,
      timestamp: new Date(),
    });

    await group.save();

    try {
      broadcast(socketEvents.RESOURCES_UPDATED, { resources: group.resources }, id);
    } catch (e) {
      console.warn('[Broadcast Error in addResource]:', e.message);
    }

    return successResponse(res, { resources: group.resources }, 'Resource published successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Delete a resource
 */
const deleteResource = async (req, res, next) => {
  try {
    const { id, resourceId } = req.params;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    group.resources = group.resources.filter((r) => r._id.toString() !== resourceId);
    await group.save();

    try {
      broadcast(socketEvents.RESOURCES_UPDATED, { resources: group.resources }, id);
    } catch (e) {
      console.warn('[Broadcast Error in deleteResource]:', e.message);
    }

    return successResponse(res, { resources: group.resources }, 'Resource removed successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Broadcast notification announcement to group
 */
const sendAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, message, target = 'ALL' } = req.body;

    if (!title || !message) {
      return errorResponse(res, 'Announcement title and message are required.', statusCodes.BAD_REQUEST);
    }

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    group.announcements.unshift({
      title: title.trim(),
      message: message.trim(),
      target,
      sentAt: new Date(),
      sentBy: req.user?.name || 'Admin',
    });

    group.activityLogs.unshift({
      action: 'Announcement Broadcast',
      actorName: req.user?.name || 'Admin',
      details: `Dispatched announcement "${title}" to target: ${target}.`,
      timestamp: new Date(),
    });

    await group.save();

    try {
      broadcast(socketEvents.GROUP_UPDATED, group, id);
    } catch (e) {
      console.warn('[Broadcast Error in sendAnnouncement]:', e.message);
    }

    return successResponse(res, { announcements: group.announcements }, 'Announcement broadcast successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Delete or Archive Group
 */
const deleteOrArchiveGroup = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { permanent = false } = req.query;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    if (permanent === 'true' || group.status === 'Draft') {
      await Group.findByIdAndDelete(id);
      try {
        broadcast(socketEvents.GROUP_UPDATED, { _id: id, deleted: true }, id);
      } catch (e) {}
      return successResponse(res, null, `Batch "${group.title}" permanently removed.`);
    }

    // Soft Archive
    group.status = 'Archived';
    group.isActive = false;
    group.activityLogs.unshift({
      action: 'Group Archived',
      actorName: req.user?.name || 'Admin',
      details: `Group archived. Historical attendance, records, and chat preserved.`,
      timestamp: new Date(),
    });

    await group.save();
    try {
      broadcast(socketEvents.GROUP_UPDATED, group, id);
    } catch (e) {}
    return successResponse(res, { group }, `Batch "${group.title}" archived successfully.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk actions on groups
 */
const bulkUpdateGroups = async (req, res, next) => {
  try {
    const { groupIds = [], action } = req.body;

    if (!groupIds || groupIds.length === 0 || !action) {
      return errorResponse(res, 'Group IDs and Action are required.', statusCodes.BAD_REQUEST);
    }

    let update = {};
    if (action === 'ACTIVATE') {
      update = { status: 'Active', isActive: true };
    } else if (action === 'DEACTIVATE') {
      update = { status: 'Inactive', isActive: false };
    } else if (action === 'ARCHIVE') {
      update = { status: 'Archived', isActive: false };
    } else if (action === 'PAUSE') {
      update = { status: 'Paused', isActive: true };
    } else {
      return errorResponse(res, `Unsupported action: ${action}`, statusCodes.BAD_REQUEST);
    }

    const result = await Group.updateMany({ _id: { $in: groupIds } }, { $set: update });
    try {
      broadcast(socketEvents.GROUP_UPDATED, { bulk: true, groupIds, update }, null);
    } catch (e) {}
    return successResponse(res, { modifiedCount: result.modifiedCount }, `Bulk action "${action}" completed for ${result.modifiedCount} groups.`);
  } catch (err) {
    next(err);
  }
};

/**
 * 11. Integrated Daily Schedule Hub
 * Returns chronological schedules for all teachers/batches with Meet links,
 * attendance status, student counts, and live/upcoming/completed statuses.
 */
const getGroupSchedules = async (req, res, next) => {
  try {
    const {
      date,
      teacherId,
      status,
      subject,
      search,
    } = req.query;

    const targetDate = date ? new Date(date) : new Date();
    const dateOnlyStr = isNaN(targetDate.getTime())
      ? new Date().toISOString().split('T')[0]
      : targetDate.toISOString().split('T')[0];

    const dayIndex = isNaN(targetDate.getTime()) ? new Date().getDay() : targetDate.getDay();
    const dayNamesList = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDayName = dayNamesList[dayIndex];

    const normalizedClassDate = new Date(`${dateOnlyStr}T00:00:00.000Z`);

    const query = {
      $or: [{ status: 'Active' }, { isActive: true }],
    };

    if (teacherId && mongoose.Types.ObjectId.isValid(teacherId)) {
      query.teacherId = teacherId;
    }
    if (subject && subject !== 'ALL') {
      query.subject = subject;
    }
    if (search && search.trim()) {
      const q = search.trim();
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { code: { $regex: q, $options: 'i' } },
          { subject: { $regex: q, $options: 'i' } },
          { teacherName: { $regex: q, $options: 'i' } },
        ],
      });
    }

    const groups = await Group.find(query)
      .populate({
        path: 'teacherId',
        model: 'Teacher',
        select: 'name email phoneNumber avatar avatarUrl qualification instruments',
      })
      .populate({
        path: 'studentIds',
        model: 'Student',
        select: 'name avatar avatarUrl status',
      })
      .lean();

    const groupIds = groups.map((g) => g._id);
    const Attendance = require('../models/Attendance');
    const attendanceRecords = await Attendance.find({
      groupId: { $in: groupIds },
      classDate: normalizedClassDate,
    }).lean();

    const attendanceByGroup = {};
    attendanceRecords.forEach((att) => {
      const gId = att.groupId.toString();
      if (!attendanceByGroup[gId]) {
        attendanceByGroup[gId] = { present: 0, absent: 0, excused: 0, total: 0 };
      }
      attendanceByGroup[gId].total += 1;
      if (att.status === 'PRESENT') attendanceByGroup[gId].present += 1;
      else if (att.status === 'ABSENT') attendanceByGroup[gId].absent += 1;
      else if (att.status === 'EXCUSED') attendanceByGroup[gId].excused += 1;
    });

    const parseTimeToMinutes = (tStr) => {
      if (!tStr) return 0;
      const match = tStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (!match) return 0;
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const meridiem = (match[3] || '').toUpperCase();
      if (meridiem === 'PM' && hours < 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;
      return hours * 60 + minutes;
    };

    const now = new Date();
    const isToday = now.toISOString().split('T')[0] === dateOnlyStr;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const schedules = [];

    groups.forEach((group) => {
      const sched = group.schedule || {};
      const daysOfWeek = sched.daysOfWeek || [];
      const dayNames = sched.dayNames || [];

      const isAllDays = date === 'ALL' || req.query.dayOfWeek === 'ALL';
      const matchesDayIndex = daysOfWeek.length > 0 ? daysOfWeek.includes(dayIndex) : false;
      const matchesDayName = dayNames.some((d) => d.toLowerCase().includes(currentDayName.toLowerCase()));

      const hasDaysDefined = daysOfWeek.length > 0 || dayNames.length > 0;
      const isScheduledForDay = isAllDays ? true : (hasDaysDefined ? (matchesDayIndex || matchesDayName) : true);

      if (!isScheduledForDay) return;

      const startTime = sched.startTime || '09:00 AM';
      const endTime = sched.endTime || '10:00 AM';
      const startMinutes = parseTimeToMinutes(startTime);
      const endMinutes = parseTimeToMinutes(endTime);

      let sessionStatus = 'UPCOMING';
      if (!isToday) {
        if (targetDate < now) {
          sessionStatus = 'COMPLETED';
        } else {
          sessionStatus = 'UPCOMING';
        }
      } else {
        if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) {
          sessionStatus = 'LIVE';
        } else if (currentMinutes > endMinutes) {
          sessionStatus = 'COMPLETED';
        } else {
          sessionStatus = 'UPCOMING';
        }
      }

      if (status && status !== 'ALL' && sessionStatus !== status) {
        return;
      }

      const attStats = attendanceByGroup[group._id.toString()];
      const teacherObj = group.teacherId || {};

      schedules.push({
        _id: group._id,
        batchId: group._id,
        batchTitle: group.title,
        batchCode: group.code,
        subject: group.subject,
        level: group.level,
        startTime,
        endTime,
        timeDisplay: `${startTime} - ${endTime}`,
        startMinutes,
        endMinutes,
        dayNames: dayNames.length > 0 ? dayNames : [currentDayName],
        meetUrl: group.meetUrl || 'https://meet.google.com/new',
        teacher: {
          _id: teacherObj._id || null,
          teacherId: teacherObj._id ? `TCH-${teacherObj._id.toString().slice(-4).toUpperCase()}` : 'TCH-104',
          name: teacherObj.name || group.teacherName || 'Unassigned Faculty',
          email: teacherObj.email || '',
          phoneNumber: teacherObj.phoneNumber || '',
          avatar: teacherObj.avatar || teacherObj.avatarUrl || '',
          qualification: teacherObj.qualification || '',
          instruments: teacherObj.instruments || [group.subject],
        },
        studentCount: group.studentIds ? group.studentIds.length : 0,
        sessionStatus,
        attendanceLogged: Boolean(attStats && attStats.total > 0),
        attendanceSummary: attStats || { present: 0, absent: 0, excused: 0, total: 0 },
      });
    });

    schedules.sort((a, b) => a.startMinutes - b.startMinutes);

    const totalScheduled = schedules.length;
    const liveNowCount = schedules.filter((s) => s.sessionStatus === 'LIVE').length;
    const upcomingCount = schedules.filter((s) => s.sessionStatus === 'UPCOMING').length;
    const completedCount = schedules.filter((s) => s.sessionStatus === 'COMPLETED').length;
    const attendanceMarkedCount = schedules.filter((s) => s.attendanceLogged).length;

    const facultySet = new Set(schedules.map((s) => s.teacher.name).filter(Boolean));

    return successResponse(res, {
      date: dateOnlyStr,
      dayName: currentDayName,
      isToday,
      kpis: {
        totalScheduled,
        liveNowCount,
        upcomingCount,
        completedCount,
        attendanceMarkedCount,
        totalFacultyTeaching: facultySet.size,
      },
      schedules,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Update class schedule configuration for a batch
 */
const updateGroupSchedule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startTime, endTime, daysOfWeek, dayNames, meetUrl, notes } = req.body;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Batch not found', statusCodes.NOT_FOUND);
    }

    if (!group.schedule) group.schedule = {};
    if (startTime !== undefined) group.schedule.startTime = startTime.trim();
    if (endTime !== undefined) group.schedule.endTime = endTime.trim();
    if (daysOfWeek !== undefined) group.schedule.daysOfWeek = daysOfWeek;
    if (dayNames !== undefined) group.schedule.dayNames = dayNames;
    if (notes !== undefined) group.schedule.notes = notes;
    if (meetUrl !== undefined) group.meetUrl = meetUrl.trim();

    await group.save();

    return successResponse(res, { group }, 'Batch timetable schedule updated successfully.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listGroups,
  getGroupStats,
  createGroup,
  getGroupById,
  updateGroup,
  assignTeacher,
  addStudents,
  removeStudent,
  addRecording,
  deleteRecording,
  logRecordingWatch,
  addResource,
  deleteResource,
  sendAnnouncement,
  deleteOrArchiveGroup,
  bulkUpdateGroups,
  getGroupSchedules,
  updateGroupSchedule,
};

