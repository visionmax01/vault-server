const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const vaultController = require('../controllers/vaultController');
const streamController = require('../controllers/streaming/streamController');
const authMiddleware = require('../middlewares/auth');

// Setup multer disk storage for buffering file uploads securely before streaming to MinIO
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

// Configure upload engine
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // Up to 10GB to allow large files within storage limits
  }
});

// All vault routes require JWT auth
router.use(authMiddleware);

// @route   GET api/vault/active-stream
// @desc    Get active stream room for current user
router.get('/active-stream', streamController.getActiveStream);

// @route   POST api/vault/terminate-stream
// @desc    Terminate active stream room for current user
router.post('/terminate-stream', streamController.terminateStream);

// @route   GET api/vault/stream-history
// @desc    Get stream room history for current user
router.get('/stream-history', streamController.getStreamHistory);

// @route   GET api/vault/content
// @desc    Get files and folders in directory
router.get('/content', vaultController.getContent);

// @route   POST api/vault/folders
// @desc    Create a new folder
router.post('/folders', vaultController.createFolder);

// @route   POST api/vault/files/upload
// @desc    Upload file to current folder
router.post('/files/upload', upload.single('file'), vaultController.uploadFile);

// @route   GET api/vault/files/upload-status
// @desc    Get chunks already uploaded for an uploadId
router.get('/files/upload-status', vaultController.getUploadStatus);

// @route   POST api/vault/files/upload-chunk
// @desc    Upload a file chunk
router.post('/files/upload-chunk', upload.single('file'), vaultController.uploadChunk);

// @route   POST api/vault/files/upload-cancel
// @desc    Cancel upload and clean up temporary chunks
router.post('/files/upload-cancel', vaultController.cancelUpload);

// @route   DELETE api/vault/files/:fileId
// @desc    Delete file from vault and MinIO
router.delete('/files/:fileId', vaultController.deleteFile);

// @route   DELETE api/vault/folders/:folderId
// @desc    Delete folder and nested elements recursively
router.delete('/folders/:folderId', vaultController.deleteFolder);

// @route   GET api/vault/folders/:folderId/size
// @desc    Get folder size recursively including all files
router.get('/folders/:folderId/size', vaultController.getFolderSize);

// @route   GET api/vault/files/stream/:fileId/:filename?
// @desc    Stream or download file contents (Supports partial content / HTTP 206)
router.get('/files/stream/:fileId/:filename?', vaultController.streamFile);

// @route   POST api/vault/subscription
// @desc    Upgrade subscription tier
router.post('/subscription', vaultController.updateSubscription);

// @route   POST api/vault/subscription/request
// @desc    Submit upgrade payment details request
router.post('/subscription/request', upload.single('screenshot'), vaultController.submitSubscriptionRequest);

// @route   GET api/vault/subscription/status
// @desc    Get current user upgrade status
router.get('/subscription/status', vaultController.getSubscriptionStatus);

// @route   PATCH api/vault/folders/:folderId
// @desc    Rename or move a folder
router.patch('/folders/:folderId', vaultController.updateFolder);

// @route   PATCH api/vault/files/:fileId
// @desc    Rename or move a file
router.patch('/files/:fileId', vaultController.updateFile);

// @route   GET api/vault/files/thumbnail/:fileId
// @desc    Stream file thumbnail image
router.get('/files/thumbnail/:fileId', vaultController.streamThumbnail);

// @route   POST api/vault/avatar
// @desc    Upload profile avatar image
router.post('/avatar', upload.single('avatar'), vaultController.uploadAvatar);

// @route   GET api/vault/avatar/:userId
// @desc    Stream user profile avatar image
router.get('/avatar/:userId', vaultController.streamAvatar);

module.exports = router;
