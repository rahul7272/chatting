const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const chatService = require('./src/services/chat.service');
const Group = require('./src/models/Group');
const Message = require('./src/models/Message');

async function testPhase3() {
  console.log('--- STARTING PHASE 3 TEST SUITE (POLL MULTI-CHOICE & UNREAD SYNC) ---');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB Atlas');

  const group = await Group.findOne();
  if (!group) throw new Error('No group found');

  const voterUser = {
    userId: new mongoose.Types.ObjectId(),
    name: 'Student MultiVoter',
    role: 'STUDENT',
  };

  // 1. Create a Multiple Choice Poll
  console.log('\n--- 1. Testing Create Multiple Choice Poll ---');
  const multiPollMsg = await chatService.createMessage(
    group._id,
    {
      text: 'Which practice sessions can you attend?',
      type: 'POLL',
      pollData: {
        question: 'Which practice sessions can you attend?',
        options: ['Morning 7 AM', 'Evening 5 PM', 'Weekend 10 AM'],
        isMultipleChoice: true,
      },
    },
    { userId: new mongoose.Types.ObjectId(), name: 'Admin Choreographer', role: 'ADMIN' }
  );

  console.log('✅ Poll created:', multiPollMsg._id);
  console.log('isMultipleChoice stored:', multiPollMsg.pollData.isMultipleChoice);
  if (!multiPollMsg.pollData.isMultipleChoice) {
    throw new Error('Failed: isMultipleChoice was not stored in MongoDB pollData!');
  }

  // 2. Vote for Option 0 (Morning)
  console.log('\n--- 2. Voting for Option 0 (Morning) ---');
  let updatedPoll = await chatService.votePoll(multiPollMsg._id, 0, voterUser);
  console.log('Option 0 votes:', updatedPoll.pollData.options[0].votes.length);
  console.log('Option 1 votes:', updatedPoll.pollData.options[1].votes.length);

  // 3. Vote for Option 1 (Evening) - MULTI CHOICE TEST
  console.log('\n--- 3. Voting for Option 1 (Evening) - Multi-Choice Verification ---');
  updatedPoll = await chatService.votePoll(multiPollMsg._id, 1, voterUser);
  const opt0Votes = updatedPoll.pollData.options[0].votes.length;
  const opt1Votes = updatedPoll.pollData.options[1].votes.length;
  console.log('Option 0 votes (should remain 1):', opt0Votes);
  console.log('Option 1 votes (should now be 1):', opt1Votes);

  if (opt0Votes !== 1 || opt1Votes !== 1) {
    throw new Error(`Multi-choice failed! Expected both options to have 1 vote, got Opt0: ${opt0Votes}, Opt1: ${opt1Votes}`);
  }
  console.log('🎉 Multi-Choice voting passed! Both Option 0 and Option 1 are selected simultaneously!');

  // 4. Toggle Option 0 (Unvote)
  console.log('\n--- 4. Toggle Option 0 (Unvote) ---');
  updatedPoll = await chatService.votePoll(multiPollMsg._id, 0, voterUser);
  const opt0VotesAfterToggle = updatedPoll.pollData.options[0].votes.length;
  const opt1VotesAfterToggle = updatedPoll.pollData.options[1].votes.length;
  console.log('Option 0 votes (should be 0 after unvote):', opt0VotesAfterToggle);
  console.log('Option 1 votes (should remain 1):', opt1VotesAfterToggle);

  if (opt0VotesAfterToggle !== 0 || opt1VotesAfterToggle !== 1) {
    throw new Error('Toggle unvote failed!');
  }
  console.log('🎉 Toggle unvote passed!');

  // 5. Test Unread Count & Mark Group As Read
  console.log('\n--- 5. Testing Unread Count & Mark As Read ---');
  const readRes = await chatService.markGroupMessagesAsRead(group._id, voterUser);
  console.log('Mark as read result:', readRes);

  // Verify seenBy has no duplicate userId entries
  const checkMsg = await Message.findById(multiPollMsg._id);
  const userSeenCount = checkMsg.seenBy.filter(s => s.userId === voterUser.userId.toString()).length;
  console.log('Occurrences of user in seenBy array (should be <= 1):', userSeenCount);
  if (userSeenCount > 1) {
    throw new Error('Duplicate seenBy entries found!');
  }

  // Cleanup
  await Message.deleteOne({ _id: multiPollMsg._id });
  console.log('✅ Test message cleaned up successfully.');

  await mongoose.disconnect();
  console.log('\n====================================================');
  console.log('🎉 ALL PHASE 3 BACKEND TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

testPhase3().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

