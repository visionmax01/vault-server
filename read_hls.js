const mongoose = require('mongoose');
require('dotenv').config();

const MovieSchema = new mongoose.Schema({
  title: String,
  category: String,
  mediaType: String,
  videoKey: String,
  mimeType: String,
  size: Number,
});
const Movie = mongoose.model('Movie', MovieSchema);

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/vault');
  console.log('DB Connected');
  
  const movies = await Movie.find({});
  console.log(`Found ${movies.length} total movies:`);
  movies.forEach(m => {
    console.log(`- ${m.title} | Mime: ${m.mimeType} | Size: ${m.size} | Key: ${m.videoKey}`);
  });
  
  process.exit(0);
}

run();
