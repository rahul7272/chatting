module.exports = {
  // Connection & Room
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  USER_ONLINE: 'user_online',
  USER_OFFLINE: 'user_offline',

  // Messages
  SEND_MESSAGE: 'send_message',
  NEW_MESSAGE: 'new_message',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_REACTION: 'message_reaction',
  MESSAGE_PINNED: 'message_pinned',
  MESSAGE_DELIVERED: 'message_delivered',
  MESSAGE_READ: 'message_read',
  MESSAGE_READ_UPDATE: 'message_read_update',

  // Typing
  TYPING_START: 'typing_start',
  USER_TYPING: 'user_typing',
  TYPING_STOP: 'typing_stop',
  USER_STOP_TYPING: 'user_stop_typing',

  // Live Classroom & Polls
  POLL_CREATED: 'poll_created',
  POLL_VOTED: 'poll_voted',
  CLASS_STARTED: 'class_started',

  // Batch & Group Real-Time Updates
  GROUP_UPDATED: 'group_updated',
  RECORDINGS_UPDATED: 'recordings_updated',
  RESOURCES_UPDATED: 'resources_updated',
  MEMBERS_UPDATED: 'members_updated',
};
