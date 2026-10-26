const mongoose = require('mongoose');
require('dotenv').config();

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const usersColl = db.collection('users');
  const studentsColl = db.collection('students');

  const allUsers = await usersColl.find({}).toArray();
  console.log('Migrating users to students collection. Found:', allUsers.length);

  for (const u of allUsers) {
    const studentDoc = {
      _id: u._id,
      name: u.name,
      phoneNumber: u.phoneNumber || null,
      alternativePhoneNumber: u.alternativePhoneNumber || null,
      email: u.email || null,
      dob: u.dob || null,
      age: u.age || null,
      city: u.city || '',
      state: u.state || '',
      instruments: u.instruments && u.instruments.length > 0 ? u.instruments : ['Harmonium'],
      studentLevel: u.studentLevel || 'Beginner',
      enrolledCreditBalance: u.enrolledCreditBalance !== undefined ? u.enrolledCreditBalance : 8,
      guardianName: u.guardianName || '',
      address: u.address || '',
      role: 'STUDENT',
      avatarUrl: u.avatarUrl || null,
      isActive: u.isActive !== undefined ? u.isActive : true,
      admissionDate: u.createdAt || new Date(),
      createdAt: u.createdAt || new Date(),
      updatedAt: u.updatedAt || new Date(),
      notes: u.notes || '',
    };
    await studentsColl.updateOne({ _id: u._id }, { $set: studentDoc }, { upsert: true });
    console.log('Saved student to students collection:', u.name);
  }

  // Drop legacy 'users' collection so it is completely gone in MongoDB Atlas!
  try {
    await usersColl.drop();
    console.log('Successfully dropped legacy "users" collection!');
  } catch (e) {
    console.log('Note on dropping users collection:', e.message);
  }

  const count = await studentsColl.countDocuments();
  console.log('Total documents in "students" collection:', count);

  const collections = await db.listCollections().toArray();
  console.log('Active collections in MongoDB now:', collections.map((c) => c.name));

  await mongoose.disconnect();
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
