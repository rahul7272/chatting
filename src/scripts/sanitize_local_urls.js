const env = require('../config/env');
const mongoose = require('mongoose');

async function run() {
  const uri = env.mongoUri;
  console.log('Connecting with URI...');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB:', mongoose.connection.host);

  const messagesCol = mongoose.connection.collection('messages');
  const localPathRegex = /(\/data\/user\/|\/storage\/|file:\/\/|file_picker|\/var\/mobile\/)/i;

  const cursor = messagesCol.find({
    $or: [
      { 'metadata.videoUrl': { $regex: localPathRegex } },
      { 'metadata.fileUrl': { $regex: localPathRegex } },
      { 'metadata.imageUrl': { $regex: localPathRegex } },
      { 'metadata.audioUrl': { $regex: localPathRegex } },
      { 'attachments.url': { $regex: localPathRegex } },
    ]
  });

  const docs = await cursor.toArray();
  console.log(`Found ${docs.length} message(s) containing local device file paths.`);

  for (const doc of docs) {
    console.log(`- Flagging message ${doc._id} (${doc.type})`);
    await messagesCol.updateOne(
      { _id: doc._id },
      {
        $set: {
          'metadata.isBrokenLocalUpload': true,
          'metadata.uploadErrorMessage': 'This file was only stored in the sender device cache and was not uploaded to the server.',
        }
      }
    );
  }

  console.log(`Successfully updated all ${docs.length} message(s).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Error running sanitization:', err);
  process.exit(1);
});
