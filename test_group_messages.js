const mongoose = require('mongoose');
require('dotenv').config({ path: __dirname + '/.env' });
const Group = require('./src/models/Group');
const Message = require('./src/models/Message');
const chatService = require('./src/services/chat.service');

async function runTests() {
  console.log('--- STARTING GROUP MESSAGE SYSTEM TEST SUITE ---');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB Atlas');

  // 1. Find or create a group for testing
  let group = await Group.findOne();
  if (!group) {
    group = await Group.create({
      title: 'Automated Test Batch',
      code: `TEST-${Date.now()}`,
      subject: 'Vocal Music',
      level: 'Beginner',
      status: 'Active',
    });
    console.log('Created test group:', group._id);
  } else {
    console.log('Using existing group:', group._id, group.title);
  }

  const groupId = group._id.toString();
  const testUserId = new mongoose.Types.ObjectId().toString();
  const adminContext = { userId: testUserId, name: 'Test Admin', role: 'ADMIN' };

  // 2. Test createMessage (Text)
  console.log('\n--- 1. Testing createMessage (Text) ---');
  const textMsg = await chatService.createMessage(groupId, {
    text: 'Hello, this is a test group message!',
    type: 'TEXT',
  }, adminContext);
  console.log('✅ Text message created:', textMsg._id, 'Text:', textMsg.text);

  // 3. Test createMessage (Poll)
  console.log('\n--- 2. Testing createMessage (Poll) ---');
  const pollMsg = await chatService.createMessage(groupId, {
    text: 'What time is best for the extra rehearsal?',
    type: 'POLL',
    pollData: {
      question: 'What time is best for the extra rehearsal?',
      options: [
        { title: '4:00 PM' },
        { title: '5:30 PM' },
        { title: '7:00 PM' },
      ],
    },
  }, adminContext);
  console.log('✅ Poll message created:', pollMsg._id, 'Options:', pollMsg.pollData.options.map(o => o.title));

  // 4. Test votePoll
  console.log('\n--- 3. Testing votePoll ---');
  const votedPoll = await chatService.votePoll(pollMsg._id, 1, {
    userId: testUserId,
    name: 'Test Student Rahul',
    role: 'STUDENT',
  });
  console.log('✅ Poll vote recorded. Option 1 voters count:', votedPoll.pollData.options[1].voters.length);

  // 5. Test togglePollStatus (Close Poll)
  console.log('\n--- 4. Testing togglePollStatus (Close Poll) ---');
  const closedPoll = await chatService.togglePollStatus(pollMsg._id, true, adminContext);
  console.log('✅ Poll closed status:', closedPoll.pollData.closed);

  // 6. Test markMessageAsRead
  console.log('\n--- 5. Testing markMessageAsRead ---');
  const readReceiptResult = await chatService.markMessageAsRead(textMsg._id, {
    userId: testUserId,
    name: 'Reader Student',
    role: 'STUDENT',
  });
  console.log('✅ Message marked as read. Seen count:', readReceiptResult.seenByCount);

  // 7. Test getMessageReadReceipts
  console.log('\n--- 6. Testing getMessageReadReceipts ---');
  const receipts = await chatService.getMessageReadReceipts(textMsg._id);
  console.log('✅ Read receipts retrieved. Total seen:', receipts.totalSeenCount, 'Students seen:', receipts.students.length);

  // 8. Test toggleReaction
  console.log('\n--- 7. Testing toggleReaction ---');
  const reactedMsg = await chatService.toggleReaction(textMsg._id, '❤️', adminContext);
  console.log('✅ Reaction added. Current reactions:', reactedMsg.reactions.map(r => `${r.userName}: ${r.emoji}`));

  // 9. Test togglePin & getPinnedMessages
  console.log('\n--- 8. Testing togglePin & getPinnedMessages ---');
  const pinnedMsg = await chatService.togglePin(textMsg._id, adminContext);
  console.log('✅ Message pinned state:', pinnedMsg.isPinned);
  const pinnedList = await chatService.getPinnedMessages(groupId);
  console.log('✅ Pinned messages count in group:', pinnedList.length);

  // 10. Test editMessage
  console.log('\n--- 9. Testing editMessage ---');
  const editedMsg = await chatService.editMessage(textMsg._id, 'Hello, this is an EDITED test group message!', adminContext);
  console.log('✅ Message edited. New text:', editedMsg.text, 'isEdited:', editedMsg.isEdited);

  // 11. Test searchMessages
  console.log('\n--- 10. Testing searchMessages ---');
  const searchResults = await chatService.searchMessages('EDITED', groupId);
  console.log('✅ Search results for "EDITED":', searchResults.length, 'found');

  // 12. Test sendSystemMessage
  console.log('\n--- 11. Testing sendSystemMessage ---');
  const systemMsg = await chatService.sendSystemMessage(groupId, '📢 Important announcement: Rehearsal scheduled for Saturday.');
  console.log('✅ System message created:', systemMsg._id, 'Text:', systemMsg.text);

  // 13. Test fetchHistory
  console.log('\n--- 12. Testing fetchHistory with pagination ---');
  const history = await chatService.fetchHistory(groupId, { page: 1, limit: 10 });
  console.log('✅ Message history retrieved. Count:', history.messages.length, 'Total in DB:', history.pagination.totalMessages);

  // 14. Clean up test messages
  console.log('\n--- 13. Cleaning up test messages ---');
  await chatService.deleteMessage(textMsg._id, adminContext, true);
  await chatService.deleteMessage(pollMsg._id, adminContext, true);
  await chatService.deleteMessage(systemMsg._id, adminContext, true);
  console.log('✅ Test messages cleaned up successfully.');

  console.log('\n====================================================');
  console.log('🎉 ALL GROUP MESSAGE SYSTEM TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');

  await mongoose.disconnect();
  process.exit(0);
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
