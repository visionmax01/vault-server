const mongoose = require('mongoose');
const StreamRoom = require('./src/models/StreamRoom');
require('dotenv').config();

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vault';

async function main() {
  await mongoose.connect(mongoUri);
  console.log('Connected to DB');
  
  try {
    const newStream = new StreamRoom({
      roomId: 'TEST_ID',
      hostId: new mongoose.Types.ObjectId('6a2585de81e70086716c8af7'),
      fileId: new mongoose.Types.ObjectId('6a258998d28db5624e7affe4'),
      fileUrl: 'http://localhost:5000/api/vault/files/stream/6a258998d28db5624e7affe4/VID-20260607-WA0011.mp4',
      title: 'VID-20260607-WA0011.mp4',
      isActive: true
    });
    
    await newStream.save();
    console.log('Room saved successfully in DB!');
  } catch (err) {
    console.error('Validation/Save Error:', err);
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Main error:', err);
  process.exit(1);
});
