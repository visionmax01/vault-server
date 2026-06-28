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

module.exports = router;
