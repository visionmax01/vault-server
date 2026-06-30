const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const adminController = require('../controllers/adminController');
const authMiddleware = require('../middlewares/auth');
const adminMiddleware = require('../middlewares/admin');

// Setup multer storage for temporary buffering
const uploadDir = path.join(__dirname, '../../temp-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // Up to 10GB for movies
  }
});

// Protect all admin routes with auth + admin checks
router.use(authMiddleware);
router.use(adminMiddleware);

// @route   GET api/admin/users
// @desc    List all users and their storage metrics
router.get('/users', adminController.listUsers);

// @route   POST api/admin/users/:userId/block
// @desc    Toggle block status for a user
router.post('/users/:userId/block', adminController.toggleBlockUser);

// @route   POST api/admin/users/:userId/subscription
// @desc    Adjust user subscription level and limit
router.post('/users/:userId/subscription', adminController.adjustSubscription);

// @route   POST api/admin/movies
// @desc    Upload public streaming movie
router.post('/movies', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'poster', maxCount: 1 }
]), adminController.uploadMovie);

// @route   PATCH api/admin/movies/:movieId
// @desc    Update public streaming movie details
router.patch('/movies/:movieId', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'poster', maxCount: 1 }
]), adminController.updateMovie);

// @route   DELETE api/admin/movies/:movieId
// @desc    Delete public streaming movie
router.delete('/movies/:movieId', adminController.deleteMovie);

// @route   GET api/admin/subscription/requests
// @desc    List all pending subscription upgrade requests
router.get('/subscription/requests', adminController.listPaymentRequests);

// @route   POST api/admin/subscription/requests/:requestId/resolve
// @desc    Approve or reject a payment request
router.post('/subscription/requests/:requestId/resolve', adminController.resolvePaymentRequest);

// @route   GET api/admin/subscription/screenshot/:requestId
// @desc    Stream payment verification screenshot
router.get('/subscription/screenshot/:requestId', adminController.streamPaymentScreenshot);

module.exports = router;
