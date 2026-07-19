const mongoose = require('mongoose');
const { minioClient, bucketName } = require('./src/config/minio');
const File = require('./src/models/File');
require('dotenv').config();

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vault';

async function testStream() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(mongoUri);
    console.log('Connected.');

    console.log('Finding a file in the database...');
    const file = await File.findOne({});
    if (!file) {
      console.log('No files found in the database. Please upload a file first.');
      process.exit(0);
    }

    console.log('Found file:');
    console.log('ID:', file._id);
    console.log('Name:', file.name);
    console.log('MimeType:', file.mimeType);
    console.log('Size:', file.size);
    console.log('Key:', file.key);
    console.log('ThumbnailKey:', file.thumbnailKey);

    console.log('\nTesting minioClient.statObject on file.key...');
    try {
      const stat = await minioClient.statObject(bucketName, file.key);
      console.log('statObject SUCCESS:', stat);
    } catch (err) {
      console.error('statObject FAILED with error:');
      console.error(err);
    }

    if (file.thumbnailKey) {
      console.log('\nTesting minioClient.statObject on file.thumbnailKey...');
      try {
        const thumbStat = await minioClient.statObject(bucketName, file.thumbnailKey);
        console.log('statObject (thumbnail) SUCCESS:', thumbStat);
      } catch (err) {
        console.error('statObject (thumbnail) FAILED with error:');
        console.error(err);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Fatal test error:', error);
    process.exit(1);
  }
}

testStream();
