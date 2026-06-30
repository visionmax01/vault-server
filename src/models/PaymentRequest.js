const mongoose = require('mongoose');

const paymentRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  plan: {
    type: String,
    enum: ['silver', 'gold', 'platinum'],
    required: true,
  },
  billing: {
    type: String,
    enum: ['monthly', 'yearly'],
    required: true,
  },
  paypalId: {
    type: String,
    required: true,
    trim: true,
  },
  screenshotKey: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('PaymentRequest', paymentRequestSchema);
