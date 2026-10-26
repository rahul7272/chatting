const Message = require('../models/Message');

class ChatService {
  async fetchHistory(groupId, page = 1, limit = 50) {
    const skip = (Number(page) - 1) * Number(limit);
    const messages = await Message.find({ groupId })
      .populate('senderId', 'name avatarUrl role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    return messages.reverse();
  }

  async createMessage(data) {
    const message = await Message.create(data);
    return await Message.findById(message._id).populate('senderId', 'name avatarUrl role');
  }

  async markAsRead(messageId, userId) {
    return await Message.findByIdAndUpdate(
      messageId,
      { $addToSet: { readBy: userId } },
      { new: true }
    );
  }
}

module.exports = new ChatService();
