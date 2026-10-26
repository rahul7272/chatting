const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const Group = require('./src/models/Group');
const Attendance = require('./src/models/Attendance');
const User = require('./src/models/User');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const groupId = '6ac16d272014553d275392fc';
  const group = await Group.findById(groupId).populate('studentIds');
  const dateStr = '2026-10-10';
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');
  const query = { groupId, classDate: { $gte: startOfDay, $lte: endOfDay } };
  const history = await Attendance.find(query).populate('studentId').lean();
  
  console.log('Students in group:', (group.studentIds || []).map(s => ({ _id: s._id.toString(), id: s.id, name: s.name })));
  console.log('History found:', JSON.stringify(history, null, 2));
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
