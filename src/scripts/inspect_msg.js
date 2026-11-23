const mongoose = require('mongoose');
const mongoUri = 'mongodb+srv://meharetech420:6lCHA6peG05IbwZ1@cluster0.63geenn.mongodb.net/chatting';

mongoose.connect(mongoUri).then(async () => {
  const db = mongoose.connection.db;
  const msgs = await db.collection('messages').find({
    $or: [
      { text: { $regex: '1001116814', $options: 'i' } },
      { 'metadata.fileName': { $regex: '1001116814', $options: 'i' } },
      { 'metadata.videoUrl': { $regex: '1001116814', $options: 'i' } },
      { 'metadata.fileUrl': { $regex: '1001116814', $options: 'i' } },
      { fileUrl: { $regex: '1001116814', $options: 'i' } }
    ]
  }).toArray();

  console.log('FOUND MESSAGES:', msgs.length);
  msgs.forEach(m => {
    console.log(JSON.stringify({
      id: m._id,
      type: m.type,
      text: m.text,
      fileUrl: m.fileUrl,
      metadata: m.metadata,
      attachments: m.attachments,
      createdAt: m.createdAt
    }, null, 2));
  });

  process.exit(0);
}).catch(err => {
  console.error('DB ERR:', err);
  process.exit(1);
});
