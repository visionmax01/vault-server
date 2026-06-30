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
      return res.status(400).json({ message: 'User not found' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Verify user is not blocked
    if (user.isBlocked) {
      return res.status(403).json({ message: 'Your account has been blocked. Please contact us at support@visionmax.com.' });
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

    // 1. Fetch user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // 2. Fetch all user files to delete associated Movie records
    const files = await File.find({ owner: userId });
    const fileKeys = files.map(f => f.key);

    const { minioClient, bucketName } = require('../config/minio');

    if (fileKeys.length > 0) {
      try {
        const Movie = require('../models/Movie');
        // Clean up movie posters first if they are not stored under the user's directory prefix
        const movies = await Movie.find({ videoKey: { $in: fileKeys } });
        for (const movie of movies) {
          if (movie.posterKey && !movie.posterKey.startsWith(`${userId}/`)) {
            await minioClient.removeObject(bucketName, movie.posterKey).catch(err => {
              console.warn(`Failed to delete out-of-prefix movie poster ${movie.posterKey}:`, err);
            });
          }
        }
        await Movie.deleteMany({ videoKey: { $in: fileKeys } });
      } catch (err) {
        console.warn('Failed to clean up Movie records:', err);
      }
    }

    // 3. Delete ALL objects starting with user prefix from MinIO (includes all raw files, transcoded HLS TS chunks, thumbnails, and avatar)
    const prefix = `${userId}/`;
    const objectsList = [];
    const stream = minioClient.listObjectsV2(bucketName, prefix, true);

    await new Promise((resolve, reject) => {
      stream.on('data', (obj) => {
        objectsList.push(obj.name);
      });
      stream.on('error', (err) => {
        console.error('Error listing objects for account deletion:', err);
        reject(err);
      });
      stream.on('end', async () => {
        try {
          if (objectsList.length > 0) {
            // MinIO removeObjects handles up to 1000 objects in a batch request.
            // Let's batch delete them in chunks of 1000 just in case there are thousands of HLS TS chunks.
            const chunkSize = 1000;
            for (let i = 0; i < objectsList.length; i += chunkSize) {
              const chunk = objectsList.slice(i, i + chunkSize);
              await minioClient.removeObjects(bucketName, chunk);
            }
            console.log(`Successfully removed ${objectsList.length} objects from bucket for user ${userId}.`);
          }
          resolve();
        } catch (err) {
          console.error('Error removing objects for account deletion:', err);
          reject(err);
        }
      });
    });

    // 4. Delete DB documents
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
