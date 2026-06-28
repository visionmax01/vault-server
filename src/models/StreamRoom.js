const mongoose = require('mongoose');

const streamRoomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    trim: true,
  },
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    required: false,
  },
  fileUrl: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  chats: {
    type: String, // Encrypted chat history JSON
    default: '',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('StreamRoom', streamRoomSchema);
