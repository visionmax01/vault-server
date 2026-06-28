const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/auth');

// @route   POST api/auth/signup
// @desc    Register a new user
router.post('/signup', authController.signup);

// @route   POST api/auth/login
// @desc    Authenticate user & get token
router.post('/login', authController.login);

// @route   GET api/auth/me
// @desc    Get current user profile details
router.get('/me', authMiddleware, authController.me);

// @route   PATCH api/auth/profile
// @desc    Update user profile name
router.patch('/profile', authMiddleware, authController.updateProfile);

// @route   POST api/auth/change-password
// @desc    Change user password
router.post('/change-password', authMiddleware, authController.changePassword);

// @route   DELETE api/auth/account
// @desc    Delete user account and all data recursively
router.delete('/account', authMiddleware, authController.deleteAccount);

module.exports = router;
