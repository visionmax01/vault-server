const mongoose = require('mongoose');
const User = require('./src/models/User');
const Folder = require('./src/models/Folder');
const File = require('./src/models/File');
const Movie = require('./src/models/Movie');
require('dotenv').config();

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vault';

async function main() {
  await mongoose.connect(mongoUri);
  console.log('Connected to DB:', mongoUri);
  
  const users = await User.find({}).lean();
  console.log('\n--- USERS ---');
  users.forEach(u => console.log(`ID: ${u._id}, Name: ${u.name}, Email: ${u.email}, Role: ${u.role}`));

  const folders = await Folder.find({}).lean();
  console.log('\n--- FOLDERS ---');
  folders.forEach(f => console.log(`ID: ${f._id}, Name: ${f.name}, Parent: ${f.parentFolder}, Owner: ${f.owner}`));

  const files = await File.find({}).lean();
  console.log('\n--- FILES ---');
  files.forEach(f => console.log(`ID: ${f._id}, Name: ${f.name}, Folder: ${f.folder}, Owner: ${f.owner}, Key: ${f.key}`));

  const movies = await Movie.find({}).lean();
  console.log('\n--- MOVIES ---');
  movies.forEach(m => console.log(`ID: ${m._id}, Title: ${m.title}, Folder: ${m.folder}, Category: ${m.category}`));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
