const User = require('../models/User');
const File = require('../models/File');
const Movie = require('../models/Movie');
const { minioClient, bucketName } = require('../config/minio');
const fs = require('fs');
const path = require('path');

// 1. List all users with their storage metrics
exports.listUsers = async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    
    // Add used storage calculation for each user
    const usersWithStorage = await Promise.all(
      users.map(async (user) => {
        const files = await File.find({ owner: user._id });
        const usedStorage = files.reduce((acc, curr) => acc + (curr.size || 0), 0);
        return {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isBlocked: user.isBlocked,
          storageLimit: user.storageLimit,
          subscription: user.subscription,
          avatarKey: user.avatarKey || null,
          usedStorage,
          createdAt: user.createdAt,
        };
      })
    );

    return res.json(usersWithStorage);
  } catch (error) {
    console.error('List users error:', error);
    return res.status(500).json({ message: 'Server error listing users' });
  }
};

// 2. Block or Unblock a user
exports.toggleBlockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Prevent blocking oneself
    if (userId.toString() === req.user.id.toString()) {
      return res.status(400).json({ message: 'You cannot block or unblock your own administrator account' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isBlocked = !user.isBlocked;
    await user.save();

    return res.json({
      message: `User has been successfully ${user.isBlocked ? 'blocked' : 'unblocked'}`,
      userId: user._id,
      isBlocked: user.isBlocked
    });
  } catch (error) {
    console.error('Toggle block user error:', error);
    return res.status(500).json({ message: 'Server error blocking/unblocking user' });
  }
};

// 3. Adjust user subscription and storage limit
exports.adjustSubscription = async (req, res) => {
  try {
    const { userId } = req.params;
    const { plan, billing } = req.body;

    if (!['free', 'silver', 'gold', 'platinum'].includes(plan)) {
      return res.status(400).json({ message: 'Invalid subscription plan' });
    }

    if (!['none', 'monthly', 'yearly'].includes(billing)) {
      return res.status(400).json({ message: 'Invalid billing option' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    let storageLimit = 3 * 1024 * 1024 * 1024; // 3GB free
    if (plan === 'silver') {
      storageLimit = 20 * 1024 * 1024 * 1024; // 20GB silver
    } else if (plan === 'gold') {
      storageLimit = 50 * 1024 * 1024 * 1024; // 50GB gold
    } else if (plan === 'platinum') {
      storageLimit = 100 * 1024 * 1024 * 1024; // 100GB platinum
    }

    let expiresAt = null;
    if (billing === 'monthly') {
      expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else if (billing === 'yearly') {
      expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }

    user.storageLimit = storageLimit;
    user.subscription = { plan, billing, expiresAt };
    await user.save();

    const files = await File.find({ owner: user._id });
    const usedStorage = files.reduce((acc, curr) => acc + (curr.size || 0), 0);

    return res.json({
      message: 'Subscription updated successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isBlocked: user.isBlocked,
        storageLimit: user.storageLimit,
        subscription: user.subscription,
        usedStorage
      }
    });
  } catch (error) {
    console.error('Adjust subscription error:', error);
    return res.status(500).json({ message: 'Server error adjusting subscription' });
  }
};

// 4. Upload public movie (video + poster)
exports.uploadMovie = async (req, res) => {
  let videoPath = null;
  let posterPath = null;

  try {
    const { title, category, mediaType, folderId, isFeatured } = req.body;
    const adminId = req.user.id;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Movie title is required' });
    }

    if (!folderId) {
      return res.status(400).json({ message: 'Parent folder is required for movie uploads' });
    }

    const Folder = require('../models/Folder');
    const folderExists = await Folder.findById(folderId);
    if (!folderExists) {
      return res.status(400).json({ message: 'Parent folder does not exist' });
    }

    if (category && !['bollywood', 'hollywood', 'bhojpuri', 'series'].includes(category)) {
      return res.status(400).json({ message: 'Invalid movie category specified' });
    }

    if (mediaType && !['movie', 'series', 'video'].includes(mediaType)) {
      return res.status(400).json({ message: 'Invalid media type specified' });
    }

    if (!req.files || !req.files['video'] || !req.files['video'][0]) {
      return res.status(400).json({ message: 'Movie video file is required' });
    }

    if (!req.files['poster'] || !req.files['poster'][0]) {
      return res.status(400).json({ message: 'Movie poster image is required' });
    }

    const videoFile = req.files['video'][0];
    const posterFile = req.files['poster'][0];

    videoPath = videoFile.path;
    posterPath = posterFile.path;

    const fileSize = videoFile.size;
    const mimeType = videoFile.mimetype;

    if (!mimeType.startsWith('video/')) {
      return res.status(400).json({ message: 'Provided file is not a valid video type' });
    }

    if (!posterFile.mimetype.startsWith('image/')) {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
      return res.status(400).json({ message: 'Provided poster file is not a valid image type' });
    }

    // Storage availability aggregate check for Admin Vault File reference
    const user = await User.findById(adminId);
    if (!user) {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
      return res.status(404).json({ message: 'Admin user not found' });
    }

    const existingFiles = await File.find({ owner: adminId });
    const usedStorage = existingFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);

    if (usedStorage + fileSize > user.storageLimit) {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
      return res.status(400).json({ message: `Storage limit exceeded. You only have ${((user.storageLimit - usedStorage) / (1024 * 1024 * 1024)).toFixed(2)} GB remaining.` });
    }

    // Generate unique Keys for MinIO
    const cleanTitle = title.trim().replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = Date.now();

    // Transcode Video to HLS
    const transcodeFolder = `hls_${Date.now()}`;
    const transcodeDir = path.join(__dirname, '../../temp-uploads', transcodeFolder);
    const hlsPrefix = `public/movies/${timestamp}_${cleanTitle}`;

    const { transcodeToHLS } = require('../utils/transcoder');
    await transcodeToHLS(videoPath, transcodeDir);

    // Upload HLS files
    const filesList = fs.readdirSync(transcodeDir);
    for (const fileItem of filesList) {
      const fileItemPath = path.join(transcodeDir, fileItem);
      const fileItemKey = `${hlsPrefix}/${fileItem}`;

      let itemMime = 'application/octet-stream';
      if (fileItem.endsWith('.m3u8')) itemMime = 'application/x-mpegURL';
      else if (fileItem.endsWith('.ts')) itemMime = 'video/MP2T';

      await minioClient.fPutObject(bucketName, fileItemKey, fileItemPath, {
        'Content-Type': itemMime,
        'Movie-Title': title,
        'Uploaded-By': adminId
      });
    }

    fs.rmSync(transcodeDir, { recursive: true, force: true });

    const finalVideoKey = `${hlsPrefix}/master.m3u8`;
    const finalMimeType = 'application/x-mpegURL';
    const posterKey = `public/movies/${timestamp}_poster_${cleanTitle}${path.extname(posterFile.originalname)}`;

    // Upload Poster to MinIO
    await minioClient.fPutObject(bucketName, posterKey, posterPath, {
      'Content-Type': posterFile.mimetype,
      'Movie-Title': title,
      'Uploaded-By': adminId
    });

    // Save Movie Record in DB
    const movie = await Movie.create({
      title: title.trim(),
      category: category || 'bollywood',
      mediaType: mediaType || 'movie',
      folder: folderId,
      videoKey: finalVideoKey,
      posterKey,
      mimeType: finalMimeType,
      size: fileSize,
      uploadedBy: adminId,
      isFeatured: isFeatured === 'true' || isFeatured === true || isFeatured === '1'
    });

    // Save File Record in DB so it shows up inside the Vault folder
    const fileExtension = path.extname(videoFile.originalname);
    const fileName = `${title.trim()}${fileExtension}`;
    
    // Check if a file with the same name already exists in this folder for the admin
    // If so, append timestamp to make it unique and avoid compound index errors
    let uniqueName = fileName;
    const duplicateFile = await File.findOne({ name: uniqueName, folder: folderId, owner: adminId });
    if (duplicateFile) {
      uniqueName = `${title.trim()}_${Date.now()}${fileExtension}`;
    }

    await File.create({
      name: uniqueName,
      key: finalVideoKey,
      mimeType: finalMimeType,
      size: fileSize,
      folder: folderId,
      owner: adminId,
      thumbnailKey: posterKey // Use the movie poster as the thumbnail for this vault file
    });

    // Cleanup temp files
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);

    return res.status(201).json(movie);
  } catch (error) {
    console.error('Upload movie error:', error);
    
    // Clean up temp files on failure
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (posterPath && fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
    
    return res.status(500).json({ message: 'Server error uploading movie' });
  }
};

// 5. Delete a public movie
exports.deleteMovie = async (req, res) => {
  try {
    const { movieId } = req.params;

    const movie = await Movie.findById(movieId);
    if (!movie) {
      return res.status(404).json({ message: 'Movie not found' });
    }

    // Remove video and poster from MinIO
    if (movie.mimeType === 'application/x-mpegURL') {
      const prefix = path.posix.dirname(movie.videoKey) + '/';
      const objectsList = [];
      const stream = minioClient.listObjectsV2(bucketName, prefix, true);
      await new Promise((resolve) => {
        stream.on('data', (obj) => objectsList.push(obj.name));
        stream.on('error', () => resolve());
        stream.on('end', async () => {
          try {
            if (objectsList.length > 0) {
              await minioClient.removeObjects(bucketName, objectsList);
            }
            resolve();
          } catch (err) {
            console.warn('Failed to delete HLS folder from MinIO:', err);
            resolve();
          }
        });
      });
    } else {
      await minioClient.removeObject(bucketName, movie.videoKey).catch(err => {
        console.warn('Failed to delete video key from MinIO:', err);
      });
    }
    
    await minioClient.removeObject(bucketName, movie.posterKey).catch(err => {
      console.warn('Failed to delete poster key from MinIO:', err);
    });

    // Delete from DB
    await Movie.deleteOne({ _id: movieId });

    return res.json({ message: 'Movie deleted successfully', movieId });
  } catch (error) {
    console.error('Delete movie error:', error);
    return res.status(500).json({ message: 'Server error deleting movie' });
  }
};

// 6. Update a public movie (with optional video/poster replacement)
exports.updateMovie = async (req, res) => {
  let videoPath = null;
  let posterPath = null;

  try {
    const { movieId } = req.params;
    const { title, category, mediaType, isFeatured } = req.body;
    const adminId = req.user.id;

    const movie = await Movie.findById(movieId);
    if (!movie) {
      return res.status(404).json({ message: 'Movie not found' });
    }

    let oldVideoKey = null;
    let oldPosterKey = null;

    // 1. Process new video file if uploaded
    if (req.files && req.files['video'] && req.files['video'][0]) {
      const videoFile = req.files['video'][0];
      videoPath = videoFile.path;

      if (!videoFile.mimetype.startsWith('video/')) {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        return res.status(400).json({ message: 'Provided file is not a valid video type' });
      }

      // Check admin storage limits for replacement video
      const oldFile = await File.findOne({ key: movie.videoKey });
      const oldSize = oldFile ? oldFile.size : 0;
      const fileSizeDiff = videoFile.size - oldSize;

      const user = await User.findById(adminId);
      if (user) {
        const existingFiles = await File.find({ owner: adminId });
        const usedStorage = existingFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);
        if (usedStorage + fileSizeDiff > user.storageLimit) {
          if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
          if (req.files['poster'] && req.files['poster'][0] && req.files['poster'][0].path && fs.existsSync(req.files['poster'][0].path)) {
            fs.unlinkSync(req.files['poster'][0].path);
          }
          return res.status(400).json({ message: `Storage limit exceeded by updating this video. You only have ${((user.storageLimit - usedStorage) / (1024 * 1024 * 1024)).toFixed(2)} GB remaining.` });
        }
      }

      const cleanTitle = (title || movie.title).trim().replace(/[^a-zA-Z0-9.-]/g, '_');
      const timestamp = Date.now();
      
      // Transcode Video to HLS
      const transcodeFolder = `hls_${Date.now()}`;
      const transcodeDir = path.join(__dirname, '../../temp-uploads', transcodeFolder);
      const hlsPrefix = `public/movies/${timestamp}_${cleanTitle}`;
      
      const { transcodeToHLS } = require('../utils/transcoder');
      await transcodeToHLS(videoPath, transcodeDir);

      // Upload HLS files
      const filesList = fs.readdirSync(transcodeDir);
      for (const fileItem of filesList) {
        const fileItemPath = path.join(transcodeDir, fileItem);
        const fileItemKey = `${hlsPrefix}/${fileItem}`;

        let itemMime = 'application/octet-stream';
        if (fileItem.endsWith('.m3u8')) itemMime = 'application/x-mpegURL';
        else if (fileItem.endsWith('.ts')) itemMime = 'video/MP2T';

        await minioClient.fPutObject(bucketName, fileItemKey, fileItemPath, {
          'Content-Type': itemMime,
          'Movie-Title': title || movie.title,
          'Uploaded-By': adminId
        });
      }

      fs.rmSync(transcodeDir, { recursive: true, force: true });

      oldVideoKey = movie.videoKey;
      movie.videoKey = `${hlsPrefix}/master.m3u8`;
      movie.mimeType = 'application/x-mpegURL';
      movie.size = videoFile.size;
    }

    // 2. Process new poster file if uploaded
    if (req.files && req.files['poster'] && req.files['poster'][0]) {
      const posterFile = req.files['poster'][0];
      posterPath = posterFile.path;

      if (!posterFile.mimetype.startsWith('image/')) {
        return res.status(400).json({ message: 'Provided poster file is not a valid image type' });
      }

      const cleanTitle = (title || movie.title).trim().replace(/[^a-zA-Z0-9.-]/g, '_');
      const timestamp = Date.now();
      const posterKey = `public/movies/${timestamp}_poster_${cleanTitle}${path.extname(posterFile.originalname)}`;

      // Upload to MinIO
      await minioClient.fPutObject(bucketName, posterKey, posterPath, {
        'Content-Type': posterFile.mimetype,
        'Movie-Title': title || movie.title,
        'Uploaded-By': adminId
      });

      oldPosterKey = movie.posterKey;
      movie.posterKey = posterKey;
    }

    // 3. Update basic metadata fields
    if (title && title.trim()) {
      movie.title = title.trim();
    }
    if (category) {
      if (!['bollywood', 'hollywood', 'bhojpuri', 'series'].includes(category)) {
        return res.status(400).json({ message: 'Invalid movie category specified' });
      }
      movie.category = category;
    }
    if (mediaType) {
      if (!['movie', 'series', 'video'].includes(mediaType)) {
        return res.status(400).json({ message: 'Invalid media type specified' });
      }
      movie.mediaType = mediaType;
    }
    if (isFeatured !== undefined) {
      movie.isFeatured = isFeatured === 'true' || isFeatured === true || isFeatured === '1';
    }

    await movie.save();

    // 4. Update the corresponding File record in the Vault folder
    const File = require('../models/File');
    const originalVideoKey = oldVideoKey || movie.videoKey;
    const vaultFile = await File.findOne({ key: originalVideoKey });
    
    if (vaultFile) {
      if (oldVideoKey) {
        vaultFile.key = movie.videoKey;
        vaultFile.mimeType = movie.mimeType;
        vaultFile.size = movie.size;
        
        const originalFile = req.files['video'][0];
        const fileExtension = path.extname(originalFile.originalname);
        
        let uniqueName = `${movie.title}${fileExtension}`;
        const duplicateFile = await File.findOne({ 
          name: uniqueName, 
          folder: vaultFile.folder, 
          owner: vaultFile.owner,
          _id: { $ne: vaultFile._id } 
        });
        if (duplicateFile) {
          uniqueName = `${movie.title}_${Date.now()}${fileExtension}`;
        }
        vaultFile.name = uniqueName;
      } else if (title && title.trim()) {
        const fileExtension = path.extname(vaultFile.name);
        let uniqueName = `${movie.title.trim()}${fileExtension}`;
        const duplicateFile = await File.findOne({ 
          name: uniqueName, 
          folder: vaultFile.folder, 
          owner: vaultFile.owner,
          _id: { $ne: vaultFile._id } 
        });
        if (duplicateFile) {
          uniqueName = `${movie.title.trim()}_${Date.now()}${fileExtension}`;
        }
        vaultFile.name = uniqueName;
      }

      if (oldPosterKey) {
        vaultFile.thumbnailKey = movie.posterKey;
      }

      await vaultFile.save();
    }

    // Delete old files from MinIO
    if (oldVideoKey) {
      if (oldVideoKey.endsWith('/master.m3u8')) {
        const prefix = path.posix.dirname(oldVideoKey) + '/';
        const objectsList = [];
        const stream = minioClient.listObjectsV2(bucketName, prefix, true);
        await new Promise((resolve) => {
          stream.on('data', (obj) => objectsList.push(obj.name));
          stream.on('error', () => resolve());
          stream.on('end', async () => {
            try {
              if (objectsList.length > 0) {
                await minioClient.removeObjects(bucketName, objectsList);
              }
              resolve();
            } catch (err) {
              console.warn('Failed to delete old HLS folder from MinIO:', err);
              resolve();
            }
          });
        });
      } else {
        await minioClient.removeObject(bucketName, oldVideoKey).catch(err => {
          console.warn('Failed to delete old video key from MinIO:', err);
        });
      }
    }
    if (oldPosterKey) {
      await minioClient.removeObject(bucketName, oldPosterKey).catch(err => {
        console.warn('Failed to delete old poster key from MinIO:', err);
      });
    }

    // Cleanup temp files
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (posterPath && fs.existsSync(posterPath)) fs.unlinkSync(posterPath);

    return res.json(movie);
  } catch (error) {
    console.error('Update movie error:', error);
    
    // Clean up temp files on failure
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (posterPath && fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
    
    return res.status(500).json({ message: 'Server error updating movie' });
  }
};

// List all pending payment requests
exports.listPaymentRequests = async (req, res) => {
  try {
    const PaymentRequest = require('../models/PaymentRequest');
    const requests = await PaymentRequest.find({ status: 'pending' })
      .populate('user', 'name email')
      .sort({ createdAt: -1 });

    return res.json(requests);
  } catch (error) {
    console.error('List payment requests error:', error);
    return res.status(500).json({ message: 'Server error listing payment requests' });
  }
};

// Approve or reject payment verification requests
exports.resolvePaymentRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action } = req.body; // 'approve' | 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action. Must be approve or reject' });
    }

    const PaymentRequest = require('../models/PaymentRequest');
    const paymentReq = await PaymentRequest.findById(requestId);
    if (!paymentReq) {
      return res.status(404).json({ message: 'Payment request not found' });
    }

    if (paymentReq.status !== 'pending') {
      return res.status(400).json({ message: 'Payment request has already been resolved' });
    }

    if (action === 'approve') {
      const targetUser = await User.findById(paymentReq.user);
      if (!targetUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Calculate new storage limit based on the requested plan
      let storageLimit = 3 * 1024 * 1024 * 1024; // 3GB free default fallback
      if (paymentReq.plan === 'silver') {
        storageLimit = 20 * 1024 * 1024 * 1024; // 20GB
      } else if (paymentReq.plan === 'gold') {
        storageLimit = 50 * 1024 * 1024 * 1024; // 50GB
      } else if (paymentReq.plan === 'platinum') {
        storageLimit = 100 * 1024 * 1024 * 1024; // 100GB
      }

      // Set expiry date: 30 days for monthly, 365 days for yearly
      let expiresAt = null;
      if (paymentReq.billing === 'monthly') {
        expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      } else if (paymentReq.billing === 'yearly') {
        expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      }

      targetUser.storageLimit = storageLimit;
      targetUser.subscription = {
        plan: paymentReq.plan,
        billing: paymentReq.billing,
        expiresAt
      };

      await targetUser.save();
      paymentReq.status = 'approved';
    } else {
      const { reason } = req.body;
      paymentReq.status = 'rejected';
      paymentReq.rejectionReason = reason || 'No specific reason provided';
    }

    await paymentReq.save();
    return res.json({
      message: `Payment request has been successfully ${action}d.`,
      request: paymentReq
    });
  } catch (error) {
    console.error('Resolve payment request error:', error);
    return res.status(500).json({ message: 'Server error resolving payment request' });
  }
};

// Stream payment verification screenshot image from MinIO
exports.streamPaymentScreenshot = async (req, res) => {
  try {
    const { requestId } = req.params;
    const PaymentRequest = require('../models/PaymentRequest');
    const paymentReq = await PaymentRequest.findById(requestId);
    
    if (!paymentReq) {
      return res.status(404).json({ message: 'Payment request not found' });
    }

    const { minioClient, bucketName } = require('../config/minio');
    
    // Check if object exists in MinIO
    try {
      const stat = await minioClient.statObject(bucketName, paymentReq.screenshotKey);
      res.setHeader('Content-Type', stat.metaData['content-type'] || 'image/png');
      res.setHeader('Content-Length', stat.size);
      
      const dataStream = await minioClient.getObject(bucketName, paymentReq.screenshotKey);
      dataStream.pipe(res);
    } catch (err) {
      console.error('Failed to retrieve screenshot from MinIO:', err);
      return res.status(404).json({ message: 'Screenshot file not found in storage' });
    }
  } catch (error) {
    console.error('Stream payment screenshot error:', error);
    return res.status(500).json({ message: 'Server error streaming screenshot' });
  }
};
