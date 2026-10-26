require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const Group = require('../models/Group');
  const avatarUrl = 'http://192.168.1.10:5000/uploads/images/1791140048753_Education_App_Chat_Flow_UI_Mockup.png';

  const dxGroup = await Group.findById('6ac16b8e2014553d27539262');
  dxGroup.avatar = avatarUrl;
  dxGroup.profilePic = avatarUrl;
  await dxGroup.save();
  console.log('Updated dxczxczxc with avatar');

  const rahulGroup = await Group.findById('6ac16d272014553d275392fc');
  rahulGroup.avatar = avatarUrl;
  rahulGroup.profilePic = avatarUrl;
  rahulGroup.studentIds = dxGroup.studentIds;
  await rahulGroup.save();
  console.log('Updated rahul with avatar and studentIds');

  const all = await Group.find({}, { title: 1, avatar: 1, profilePic: 1, studentIds: 1 });
  console.log('All groups now:', JSON.stringify(all, null, 2));

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
