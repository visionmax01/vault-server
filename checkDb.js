const mongoose = require('mongoose');
const StreamRoom = require('./src/models/StreamRoom');
require('dotenv').config();

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vault';

async function main() {
  await mongoose.connect(mongoUri);
  console.log('Connected to DB');
  
  const rooms = await StreamRoom.find({}).lean();
  console.log('Total rooms:', rooms.length);
  console.log('Rooms in DB:', JSON.stringify(rooms, null, 2));
  
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
