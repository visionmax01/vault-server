const mongoose = require('mongoose');

const movieSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  videoKey: {
    type: String,
    required: true, // MinIO object key for video
  },
  posterKey: {
    type: String,
    required: true, // MinIO object key for poster image
  },
  mimeType: {
    type: String,
    required: true, // video/mp4, video/mkv, etc.
  },
  size: {
    type: Number,
    required: true, // Video file size in bytes
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  category: {
    type: String,
    enum: ['bollywood', 'hollywood', 'bhojpuri', 'series'],
    default: 'bollywood',
    required: true,
  },
  mediaType: {
    type: String,
    enum: ['movie', 'series', 'video'],
    default: 'movie',
    required: true,
  },
  folder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    required: true,
  },
  isFeatured: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('Movie', movieSchema);
