const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  key: {
    type: String,
    required: true,
    unique: true, // Unique object identifier in MinIO
  },
  mimeType: {
    type: String,
    required: true,
  },
  size: {
    type: Number,
    required: true, // Size in bytes
  },
  folder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null, // Null indicates root directory
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  thumbnailKey: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

// Compound index to ensure uniqueness of file names within the same folder for a given user
fileSchema.index({ name: 1, folder: 1, owner: 1 }, { unique: true });

module.exports = mongoose.model('File', fileSchema);
