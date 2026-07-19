const mongoose = require('mongoose');

const PlaybackPositionSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  filePath: {
    type: String,
    required: true,
  },
  currentTime: {
    type: Number,
    required: true,
  },
  duration: {
    type: Number,
    required: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Ensure a user can only have one resume position per file path
PlaybackPositionSchema.index({ owner: 1, filePath: 1 }, { unique: true });

module.exports = mongoose.model('PlaybackPosition', PlaybackPositionSchema);
