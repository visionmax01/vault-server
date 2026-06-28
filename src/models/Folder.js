const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  parentFolder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

// Compound index to ensure uniqueness of folder names within the same parent folder for a given user
folderSchema.index({ name: 1, parentFolder: 1, owner: 1 }, { unique: true });

module.exports = mongoose.model('Folder', folderSchema);
