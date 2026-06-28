const User = require('../models/User');
const File = require('../models/File');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Helper to sign JWT Token
const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET || 'supersecretjwtkey', {
    expiresIn: '30d', // Session valid for 30 days
  });
};

// Signup Controller
exports.signup = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide name, email and password' });
    }

    // Check if user already exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user (defaults: free plan, 3GB limit)
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      storageLimit: 3 * 1024 * 1024 * 1024, // 3 GB
      role: 'user',
      subscription: {
        plan: 'free',
        billing: 'none',
        expiresAt: null
      }
    });

    const token = generateToken(user._id);

    return res.status(201).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isBlocked: user.isBlocked,
        storageLimit: user.storageLimit,
        subscription: user.subscription,
        avatarKey: user.avatarKey || null,
        usedStorage: 0
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ message: 'Server error during registration' });
  }
};

// Login Controller
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Compute storage used dynamically
    const files = await File.find({ owner: user._id });
    const usedStorage = files.reduce((acc, curr) => acc + (curr.size || 0), 0);

    const token = generateToken(user._id);

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isBlocked: user.isBlocked,
        storageLimit: user.storageLimit,
        subscription: user.subscription,
        avatarKey: user.avatarKey || null,
        usedStorage
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Server error during login' });
  }
};

// Get current logged-in user profile
exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Compute storage used dynamically
    const files = await File.find({ owner: user._id });
    const usedStorage = files.reduce((acc, curr) => acc + (curr.size || 0), 0);

    return res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      isBlocked: user.isBlocked,
      storageLimit: user.storageLimit,
      subscription: user.subscription,
      avatarKey: user.avatarKey || null,
      usedStorage
    });
  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json({ message: 'Server error fetching user profile' });
  }
};
