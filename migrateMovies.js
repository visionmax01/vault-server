const mongoose = require('mongoose');
const Movie = require('./src/models/Movie');
const File = require('./src/models/File');
const Folder = require('./src/models/Folder');
require('dotenv').config();

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vault';

async function main() {
  await mongoose.connect(mongoUri);
  console.log('Connected to DB');

  // Find Bollywood movies folder for bhishansah68@gmail.com
  const adminId = '6a26c9e9921fa9cc88930be1';
  const targetFolder = await Folder.findOne({ owner: adminId, name: 'Bollywood movies' });
  
  if (!targetFolder) {
    console.error('Target folder "Bollywood movies" not found!');
    process.exit(1);
  }

  console.log(`Target Folder found: ${targetFolder.name} (${targetFolder._id})`);

  // Find all movies uploaded by this admin where folder is undefined/null
  const movies = await Movie.find({ uploadedBy: adminId });
  console.log(`Found ${movies.length} movies to check/migrate.`);

  for (const movie of movies) {
    let updated = false;

    // 1. Update Movie folder field if missing
    if (!movie.folder) {
      movie.folder = targetFolder._id;
      await movie.save();
      console.log(`Updated Movie "${movie.title}" folder reference.`);
      updated = true;
    }

    // 2. Create File record if it doesn't exist
    const fileExists = await File.findOne({ key: movie.videoKey });
    if (!fileExists) {
      const path = require('path');
      const fileExtension = path.extname(movie.videoKey) || '.mp4';
      const fileName = `${movie.title}${fileExtension}`;

      // Check name unique
      let uniqueName = fileName;
      const duplicate = await File.findOne({ name: uniqueName, folder: targetFolder._id, owner: adminId });
      if (duplicate) {
        uniqueName = `${movie.title}_${Date.now()}${fileExtension}`;
      }

      await File.create({
        name: uniqueName,
        key: movie.videoKey,
        mimeType: movie.mimeType,
        size: movie.size,
        folder: targetFolder._id,
        owner: adminId,
        thumbnailKey: movie.posterKey
      });
      console.log(`Created File record for Movie "${movie.title}" as "${uniqueName}".`);
    } else {
      console.log(`File record already exists for Movie "${movie.title}".`);
    }
  }

  console.log('Migration finished successfully!');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
