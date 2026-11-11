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
const chatService = require('../services/chat.service');

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
      path: 'teacherIds',
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
          { teacherIds: userId },
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
    const currentUserId = req.query.userId || req.user?.userId;

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
                readBy: { $nin: userObjIds },
                'seenBy.userId': { $nin: [currentUserIdStr] },
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

    const rawTeacherIds = Array.isArray(req.body.teacherIds) ? req.body.teacherIds : (teacherId ? [teacherId] : []);
    const initialTeacherId = teacherId || (rawTeacherIds.length > 0 ? rawTeacherIds[0] : null);

    let resolvedTeacherName = teacherName;
    if (initialTeacherId) {
      const teacherDoc = (await Teacher.findById(initialTeacherId)) || (await User.findById(initialTeacherId));
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
      teacherId: initialTeacherId || null,
      teacherIds: rawTeacherIds,
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
 * Assign, Reassign or Multi-Allocate Teachers with historical tracking
 */
const assignTeacher = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { teacherId, teacherIds, teacherName, primaryTeacherId, reason = 'Faculty reallocation' } = req.body;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const previousTeacherName = group.teacherName || 'None';
    const oldTeacherIds = (group.teacherIds || []).map((t) => t.toString());

    // Check if client passed an array of teacherIds (Multi-Teacher mode)
    let newTeacherIds = [];
    if (Array.isArray(teacherIds)) {
      newTeacherIds = teacherIds.filter((t) => mongoose.Types.ObjectId.isValid(t)).map((t) => t.toString());
    } else if (teacherId && mongoose.Types.ObjectId.isValid(teacherId)) {
      newTeacherIds = [teacherId.toString()];
    }

    // Determine primary / lead faculty
    let primaryId = primaryTeacherId || teacherId;
    if (!primaryId && newTeacherIds.length > 0) {
      primaryId = newTeacherIds[0];
    }
    if (primaryId && !newTeacherIds.includes(primaryId.toString())) {
      newTeacherIds.unshift(primaryId.toString());
    }

    // Resolve primary teacher name
    let resolvedName = teacherName || '';
    if (primaryId) {
      const teacherDoc = (await Teacher.findById(primaryId)) || (await User.findById(primaryId));
      if (teacherDoc) {
        resolvedName = teacherDoc.name || resolvedName;
      }
    }

    // Mark previous teacher history record with removedAt if lead teacher changed
    if (group.teacherId && group.teacherId.toString() !== (primaryId ? primaryId.toString() : '')) {
      if (group.teacherHistory && group.teacherHistory.length > 0) {
        const lastHistory = group.teacherHistory[group.teacherHistory.length - 1];
        if (!lastHistory.removedAt) {
          lastHistory.removedAt = new Date();
        }
      }
    }

    // Add history for any newly assigned teachers
    for (const tid of newTeacherIds) {
      if (!oldTeacherIds.includes(tid)) {
        const doc = (await Teacher.findById(tid)) || (await User.findById(tid));
        group.teacherHistory.push({
          teacherId: tid,
          teacherName: doc?.name || 'Faculty Member',
          assignedAt: new Date(),
          assignedBy: req.user?.name || 'Admin',
          reason,
        });
      }
    }

    group.teacherIds = newTeacherIds;
    group.teacherId = primaryId || null;
    group.teacherName = resolvedName || '';

    group.activityLogs.unshift({
      action: 'Teacher Reassigned',
      actorName: req.user?.name || 'Admin',
      details: `Faculty roster updated: ${newTeacherIds.length} instructors. Lead: "${resolvedName || 'Unassigned'}". Reason: ${reason}`,
      timestamp: new Date(),
    });

    await group.save();

    const populated = await populateGroup(Group.findById(id));

    try {
      broadcast(socketEvents.GROUP_UPDATED, populated, id);
      if (resolvedName) {
        chatService.sendSystemMessage(id, `🎓 Faculty allocation updated: ${resolvedName} (${reason || 'Faculty Mentor'})`, {
          action: 'TEACHER_ASSIGNED',
          teacherId: primaryId,
          teacherIds: newTeacherIds,
          teacherName: resolvedName,
        });
      }
    } catch (e) {
      console.warn('[Broadcast Error in assignTeacher]:', e.message);
    }

    return successResponse(
      res,
      { group: populated },
      `Faculty allocated successfully (${newTeacherIds.length} teacher${newTeacherIds.length > 1 ? 's' : ''}). Lead: ${resolvedName || 'Unassigned'}.`
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Add one or more Teachers to Group faculty roster
 */
const addTeachers = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { teacherIds = [], reason = 'Additional Faculty Mentor Allocation' } = req.body;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const existingIds = (group.teacherIds || []).map((t) => t.toString());
    const validNewIds = teacherIds
      .filter((tid) => mongoose.Types.ObjectId.isValid(tid))
      .map((tid) => tid.toString())
      .filter((tid) => !existingIds.includes(tid));

    if (validNewIds.length === 0) {
      const populated = await populateGroup(Group.findById(id));
      return successResponse(res, { group: populated }, 'Selected faculty members are already assigned to this batch.');
    }

    const updatedTeacherIds = [...existingIds, ...validNewIds];
    group.teacherIds = updatedTeacherIds;

    // If no lead teacher was set, set first added teacher as lead
    if (!group.teacherId && updatedTeacherIds.length > 0) {
      group.teacherId = updatedTeacherIds[0];
      const leadDoc = (await Teacher.findById(group.teacherId)) || (await User.findById(group.teacherId));
      group.teacherName = leadDoc?.name || '';
    }

    // Add history entries
    for (const tid of validNewIds) {
      const doc = (await Teacher.findById(tid)) || (await User.findById(tid));
      group.teacherHistory.push({
        teacherId: tid,
        teacherName: doc?.name || 'Faculty Member',
        assignedAt: new Date(),
        assignedBy: req.user?.name || 'Admin',
        reason,
      });
    }

    group.activityLogs.unshift({
      action: 'Faculty Added',
      actorName: req.user?.name || 'Admin',
      details: `${validNewIds.length} faculty member(s) added to batch.`,
      timestamp: new Date(),
    });

    await group.save();

    const populated = await populateGroup(Group.findById(id));

    try {
      broadcast(socketEvents.GROUP_UPDATED, populated, id);
      chatService.sendSystemMessage(id, `🎓 ${validNewIds.length} new instructor(s) added to this batch roster.`, {
        action: 'TEACHERS_ADDED',
        count: validNewIds.length,
      });
    } catch (e) {
      console.warn('[Broadcast Error in addTeachers]:', e.message);
    }

    return successResponse(res, { group: populated }, `${validNewIds.length} faculty member(s) assigned successfully.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Remove a specific Teacher from Group faculty roster
 */
const removeTeacher = async (req, res, next) => {
  try {
    const { id, teacherId } = req.params;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const existingIds = (group.teacherIds || []).map((t) => t.toString());
    const targetIdStr = teacherId.toString();

    if (!existingIds.includes(targetIdStr) && group.teacherId?.toString() !== targetIdStr) {
      return errorResponse(res, 'Teacher is not assigned to this batch.', statusCodes.BAD_REQUEST);
    }

    // Remove from teacherIds
    const remainingIds = existingIds.filter((tid) => tid !== targetIdStr);
    group.teacherIds = remainingIds;

    // Resolve name of removed teacher
    const removedDoc = (await Teacher.findById(teacherId)) || (await User.findById(teacherId));
    const removedName = removedDoc?.name || 'Faculty Member';

    // If removed teacher was the primary lead, promote next available or clear
    let leadChanged = false;
    if (group.teacherId && group.teacherId.toString() === targetIdStr) {
      leadChanged = true;
      if (remainingIds.length > 0) {
        group.teacherId = remainingIds[0];
        const nextLeadDoc = (await Teacher.findById(remainingIds[0])) || (await User.findById(remainingIds[0]));
        group.teacherName = nextLeadDoc?.name || '';
      } else {
        group.teacherId = null;
        group.teacherName = '';
      }
    }

    // Update history record
    if (group.teacherHistory && group.teacherHistory.length > 0) {
      const matchHistory = group.teacherHistory
        .slice()
        .reverse()
        .find((h) => h.teacherId?.toString() === targetIdStr && !h.removedAt);
      if (matchHistory) {
        matchHistory.removedAt = new Date();
      }
    }

    group.activityLogs.unshift({
      action: 'Faculty Removed',
      actorName: req.user?.name || 'Admin',
      details: `Teacher "${removedName}" removed from cohort. ${leadChanged ? `New lead: "${group.teacherName || 'None'}"` : ''}`,
      timestamp: new Date(),
    });

    await group.save();

    const populated = await populateGroup(Group.findById(id));

    try {
      broadcast(socketEvents.GROUP_UPDATED, populated, id);
      chatService.sendSystemMessage(id, `ℹ️ Instructor ${removedName} has been unassigned from this batch.`, {
        action: 'TEACHER_REMOVED',
        teacherId,
        teacherName: removedName,
      });
    } catch (e) {
      console.warn('[Broadcast Error in removeTeacher]:', e.message);
    }

    return successResponse(res, { group: populated }, `Faculty member "${removedName}" unassigned successfully.`);
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
      chatService.sendSystemMessage(id, `👥 ${newIds.length} new student${newIds.length > 1 ? 's' : ''} joined the batch.`, {
        action: 'STUDENTS_ADDED',
        count: newIds.length,
      });
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
      chatService.sendSystemMessage(id, `🎥 New class recording uploaded: "${title.trim()}"`, {
        action: 'RECORDING_ADDED',
        title: title.trim(),
        url: url.trim(),
      });
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
    const { title, type = 'note', fileUrl, description, dueDate, targetDate } = req.body;

    if (!title) {
      return errorResponse(res, 'Resource title is required.', statusCodes.BAD_REQUEST);
    }

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const resolvedDate = targetDate || dueDate || '';

    // Auto-detect extension from fileUrl if available
    let resolvedType = type || 'note';
    if (fileUrl) {
      const cleanUrl = fileUrl.toLowerCase().trim().split('?')[0].split('#')[0];
      if (cleanUrl.endsWith('.xlsx') || cleanUrl.endsWith('.xls') || cleanUrl.endsWith('.csv') || cleanUrl.endsWith('.ods')) {
        resolvedType = 'excel';
      } else if (cleanUrl.endsWith('.pdf')) {
        resolvedType = 'pdf';
      } else if (cleanUrl.endsWith('.mp3') || cleanUrl.endsWith('.wav') || cleanUrl.endsWith('.m4a') || cleanUrl.endsWith('.aac') || cleanUrl.endsWith('.ogg')) {
        resolvedType = 'audio';
      } else if (cleanUrl.endsWith('.doc') || cleanUrl.endsWith('.docx') || cleanUrl.endsWith('.txt') || cleanUrl.endsWith('.rtf') || cleanUrl.endsWith('.ppt') || cleanUrl.endsWith('.pptx')) {
        resolvedType = 'document';
      }
    }

    group.resources.unshift({
      title: title.trim(),
      type: resolvedType,
      fileUrl: fileUrl ? fileUrl.trim() : '',
      description: description ? description.trim() : '',
      dueDate: resolvedDate,
      targetDate: resolvedDate,
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
      chatService.sendSystemMessage(id, `📄 New ${type || 'resource'} uploaded: "${title.trim()}"`, {
        action: 'RESOURCE_ADDED',
        title: title.trim(),
        fileUrl: fileUrl ? fileUrl.trim() : '',
      });
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
 * Update a note / assignment resource
 */
const updateResource = async (req, res, next) => {
  try {
    const { id, resourceId } = req.params;
    const { title, type, fileUrl, description, dueDate, targetDate, isPublished } = req.body;

    const group = await Group.findById(id);
    if (!group) {
      return errorResponse(res, 'Group not found.', statusCodes.NOT_FOUND);
    }

    const resource = group.resources.id(resourceId);
    if (!resource) {
      return errorResponse(res, 'Resource not found.', statusCodes.NOT_FOUND);
    }

    if (title !== undefined) resource.title = title.trim();
    if (fileUrl !== undefined) {
      resource.fileUrl = fileUrl.trim();
      // Auto-detect extension if type is generic or missing
      if (!type || type === 'note' || type === 'document') {
        const cleanUrl = fileUrl.toLowerCase().trim().split('?')[0].split('#')[0];
        if (cleanUrl.endsWith('.xlsx') || cleanUrl.endsWith('.xls') || cleanUrl.endsWith('.csv') || cleanUrl.endsWith('.ods')) {
          resource.type = 'excel';
        } else if (cleanUrl.endsWith('.pdf')) {
          resource.type = 'pdf';
        } else if (cleanUrl.endsWith('.mp3') || cleanUrl.endsWith('.wav') || cleanUrl.endsWith('.m4a') || cleanUrl.endsWith('.aac')) {
          resource.type = 'audio';
        } else if (cleanUrl.endsWith('.doc') || cleanUrl.endsWith('.docx') || cleanUrl.endsWith('.txt')) {
          resource.type = 'document';
        }
      }
    }
    if (type !== undefined) resource.type = type;
    if (description !== undefined) resource.description = description.trim();
    const resolvedDate = targetDate !== undefined ? targetDate : dueDate;
    if (resolvedDate !== undefined) {
      resource.dueDate = resolvedDate;
      resource.targetDate = resolvedDate;
    }
    if (isPublished !== undefined) resource.isPublished = Boolean(isPublished);

    await group.save();

    try {
      broadcast(socketEvents.RESOURCES_UPDATED, { resources: group.resources }, id);
    } catch (e) {
      console.warn('[Broadcast Error in updateResource]:', e.message);
    }

    return successResponse(res, { resources: group.resources }, 'Resource updated successfully.');
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
      chatService.sendSystemMessage(id, `📢 Announcement: ${title.trim()}\n${message.trim()}`, {
        action: 'ANNOUNCEMENT',
        title: title.trim(),
        target,
      });
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

    const dayNamesList = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let dayIndex;
    let currentDayName;
    let dateOnlyStr;

    if (date && date !== 'ALL' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m, d] = date.split('-').map(Number);
      const localDt = new Date(y, m - 1, d);
      dayIndex = localDt.getDay();
      currentDayName = dayNamesList[dayIndex];
      dateOnlyStr = date;
    } else {
      const now = new Date();
      dayIndex = now.getDay();
      currentDayName = dayNamesList[dayIndex];
      dateOnlyStr = date === 'ALL' ? 'ALL' : now.toISOString().split('T')[0];
    }

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
        select: 'name email phoneNumber avatar avatarUrl qualification instruments teacherId',
      })
      .populate({
        path: 'teacherIds',
        model: 'Teacher',
        select: 'name email phoneNumber avatar avatarUrl qualification instruments teacherId',
      })
      .populate({
        path: 'studentIds',
        model: 'Student',
        select: 'name avatar avatarUrl status phoneNumber email enrollmentNo instruments studentLevel',
      })
      .lean();

    const groupIds = groups.map((g) => g._id);
    const Attendance = require('../models/Attendance');

    const attendanceQuery = { groupId: { $in: groupIds } };
    if (dateOnlyStr !== 'ALL') {
      const startOfDay = new Date(`${dateOnlyStr}T00:00:00.000Z`);
      const endOfDay = new Date(`${dateOnlyStr}T23:59:59.999Z`);
      attendanceQuery.classDate = { $gte: startOfDay, $lte: endOfDay };
    }

    const attendanceRecords = await Attendance.find(attendanceQuery).lean();

    const attendanceByGroup = {};
    const attendanceStudentMap = {};
    attendanceRecords.forEach((att) => {
      const gId = att.groupId ? att.groupId.toString() : '';
      const sId = att.studentId ? att.studentId.toString() : '';
      if (!attendanceByGroup[gId]) {
        attendanceByGroup[gId] = { present: 0, absent: 0, excused: 0, total: 0 };
      }
      attendanceByGroup[gId].total += 1;
      if (att.status === 'PRESENT') attendanceByGroup[gId].present += 1;
      else if (att.status === 'ABSENT') attendanceByGroup[gId].absent += 1;
      else if (att.status === 'EXCUSED') attendanceByGroup[gId].excused += 1;

      if (gId && sId) {
        attendanceStudentMap[`${gId}_${sId}`] = att.status;
      }
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
    const todayYMD = now.toISOString().split('T')[0];
    const isToday = dateOnlyStr === todayYMD;
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

      let durationMinutes = endMinutes >= startMinutes ? endMinutes - startMinutes : (1440 - startMinutes + endMinutes);
      if (durationMinutes === 0) durationMinutes = 60;
      const durHours = Math.floor(durationMinutes / 60);
      const durMins = durationMinutes % 60;
      const durationFormatted = durHours > 0 ? (durMins > 0 ? `${durHours}h ${durMins}m` : `${durHours}h`) : `${durMins}m`;

      const timePeriod = startMinutes < 12 * 60 ? 'MORNING' : (startMinutes < 17 * 60 ? 'AFTERNOON' : 'EVENING');

      let sessionStatus = 'UPCOMING';
      if (!isToday && dateOnlyStr !== 'ALL') {
        const targetDateObj = new Date(dateOnlyStr);
        if (targetDateObj < new Date(todayYMD)) {
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

      // Map complete enrolled student roster with attendance indicators
      const students = (group.studentIds || []).map((st) => {
        const sId = st._id ? st._id.toString() : '';
        const attStatus = attendanceStudentMap[`${group._id}_${sId}`] || 'PENDING';
        return {
          _id: st._id,
          name: st.name || 'Student',
          enrollmentNo: st.enrollmentNo || '',
          email: st.email || '',
          phoneNumber: st.phoneNumber || '',
          avatar: st.avatar || st.avatarUrl || '',
          status: st.status || 'Active',
          studentLevel: st.studentLevel || group.level,
          attendanceStatus: attStatus,
        };
      });

      // Co-teachers
      const coTeachers = (group.teacherIds || [])
        .filter((t) => t && t._id && (!teacherObj._id || t._id.toString() !== teacherObj._id.toString()))
        .map((t) => ({
          _id: t._id,
          name: t.name,
          avatar: t.avatar || t.avatarUrl || '',
          qualification: t.qualification || '',
        }));

      schedules.push({
        _id: group._id,
        batchId: group._id,
        batchTitle: group.title,
        batchCode: group.code,
        subject: group.subject,
        level: group.level,
        description: group.description || '',
        startTime,
        endTime,
        timeDisplay: `${startTime} - ${endTime}`,
        startMinutes,
        endMinutes,
        durationMinutes,
        durationFormatted,
        timePeriod,
        dayNames: dayNames.length > 0 ? dayNames : [currentDayName],
        meetUrl: group.meetUrl || 'https://meet.google.com/new',
        teacher: {
          _id: teacherObj._id || null,
          teacherId: teacherObj.teacherId || (teacherObj._id ? `TCH-${teacherObj._id.toString().slice(-4).toUpperCase()}` : 'TCH-104'),
          name: teacherObj.name || group.teacherName || 'Unassigned Faculty',
          email: teacherObj.email || '',
          phoneNumber: teacherObj.phoneNumber || '',
          avatar: teacherObj.avatar || teacherObj.avatarUrl || '',
          qualification: teacherObj.qualification || '',
          instruments: teacherObj.instruments || [group.subject],
        },
        coTeachers,
        students,
        studentCount: students.length,
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
  addTeachers,
  removeTeacher,
  addStudents,
  removeStudent,
  addRecording,
  deleteRecording,
  logRecordingWatch,
  addResource,
  updateResource,
  deleteResource,
  sendAnnouncement,
  deleteOrArchiveGroup,
  bulkUpdateGroups,
  getGroupSchedules,
  updateGroupSchedule,
};

