const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
  },
  storageLimit: {
    type: Number,
    default: 3 * 1024 * 1024 * 1024, // 3 GB in bytes
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'silver', 'gold', 'platinum'],
      default: 'free',
    },
    billing: {
      type: String,
      enum: ['none', 'monthly', 'yearly'],
      default: 'none',
    },
    expiresAt: {
      type: Date,
      default: null,
    }
  },
  avatarKey: {
    type: String,
    default: null,
  },
  vaultFolder: {
    type: String,
    default: null,
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  isBlocked: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('User', userSchema);
