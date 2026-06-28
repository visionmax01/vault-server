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

// Update user profile details
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.name = name.trim();
    await user.save();

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
    console.error('Update profile error:', error);
    return res.status(500).json({ message: 'Server error updating profile' });
  }
};

// Change user password
exports.changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: 'Please provide current password and new password' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Verify old password
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    await user.save();

    return res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ message: 'Server error changing password' });
  }
};

// Delete user account recursively (DB + MinIO)
exports.deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch user to get avatar
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // 2. Fetch all user files
    const files = await File.find({ owner: userId });

    // 3. Delete files from MinIO / Backblaze B2
    const { minioClient, bucketName } = require('../config/minio');
    for (const file of files) {
      try {
        await minioClient.removeObject(bucketName, file.key);
      } catch (err) {
        console.warn(`Failed to delete file object ${file.key} from MinIO:`, err);
      }

      if (file.thumbnailKey) {
        try {
          await minioClient.removeObject(bucketName, file.thumbnailKey);
        } catch (err) {
          console.warn(`Failed to delete thumbnail object ${file.thumbnailKey} from MinIO:`, err);
        }
      }
    }

    // 4. Delete user profile avatar from MinIO
    if (user.avatarKey) {
      try {
        await minioClient.removeObject(bucketName, user.avatarKey);
      } catch (err) {
        console.warn(`Failed to delete avatar object ${user.avatarKey} from MinIO:`, err);
      }
    }

    // 5. Delete DB documents
    const Folder = require('../models/Folder');
    await File.deleteMany({ owner: userId });
    await Folder.deleteMany({ owner: userId });
    await User.findByIdAndDelete(userId);

    return res.json({ message: 'Account and all associated files deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    return res.status(500).json({ message: 'Server error during account deletion' });
  }
};
