const Folder = require('../models/Folder');
const File = require('../models/File');
const User = require('../models/User');
const { minioClient, bucketName } = require('../config/minio');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Helper to extract a video frame using ffmpeg
const extractVideoThumbnail = (videoPath, outputPath) => {
  return new Promise((resolve, reject) => {
    // -y overrides output, -ss 00:00:01 seek position, -vframes 1 captures 1 frame
    const cmd = `ffmpeg -y -i "${videoPath}" -ss 00:00:01 -vframes 1 -f image2 "${outputPath}"`;
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error) => {
      if (error) {
        // Fallback to beginning of video if 1 sec seek fails
        const fallbackCmd = `ffmpeg -y -i "${videoPath}" -ss 00:00:00 -vframes 1 -f image2 "${outputPath}"`;
        exec(fallbackCmd, { maxBuffer: 1024 * 1024 * 10 }, (fallbackErr) => {
          if (fallbackErr) reject(fallbackErr);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  });
};

// Helper to list and get all HLS sub-keys inside a prefix folder in MinIO
const getHlsSubKeys = (masterKey) => {
  return new Promise((resolve) => {
    const prefix = path.posix.dirname(masterKey) + '/';
    const keys = [];
    const stream = minioClient.listObjectsV2(bucketName, prefix, true);
    stream.on('data', (obj) => {
      keys.push(obj.name);
    });
    stream.on('error', () => {
      resolve([masterKey]); // Fallback to delete just master key if list fails
    });
    stream.on('end', () => {
      resolve(keys);
    });
  });
};

// 1. Get folders and files in current folder
exports.getContent = async (req, res) => {
  try {
    const owner = req.user.id;
    let folderId = req.query.folderId;
    
    // Normalize root folder search
    if (folderId === 'null' || folderId === 'undefined' || !folderId) {
      folderId = null;
    }

    // Fetch folders
    const folders = await Folder.find({ owner, parentFolder: folderId }).sort({ name: 1 });

    // Fetch files
    const files = await File.find({ owner, folder: folderId }).sort({ name: 1 });

    return res.json({ folders, files });
  } catch (error) {
    console.error('Get vault content error:', error);
    return res.status(500).json({ message: 'Server error retrieving vault contents' });
  }
};

// 2. Create a folder
exports.createFolder = async (req, res) => {
  try {
    const { name, parentFolderId } = req.body;
    const owner = req.user.id;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Folder name is required' });
    }

    const folderParent = parentFolderId && parentFolderId !== 'null' ? parentFolderId : null;

    // Check for duplicate folder name inside same directory
    const duplicate = await Folder.findOne({ name: name.trim(), parentFolder: folderParent, owner });
    if (duplicate) {
      return res.status(400).json({ message: 'A folder with this name already exists here' });
    }

    const folder = await Folder.create({
      name: name.trim(),
      parentFolder: folderParent,
      owner,
    });

    return res.status(201).json(folder);
  } catch (error) {
    console.error('Create folder error:', error);
    return res.status(500).json({ message: 'Server error creating folder' });
  }
};

// Helper to process and save uploaded file (MinIO upload, HLS transcoding, PDF/Video thumbnail, DB record)
const processAndSaveUploadedFile = async (owner, folderId, filePath, fileSize, originalName, mimeType) => {
  // Get User and verify storage availability
  const user = await User.findById(owner);
  if (!user) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    throw new Error('User not found');
  }

  // Dynamic storage consumption aggregate check
  const existingFiles = await File.find({ owner });
  const usedStorage = existingFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);

  if (usedStorage + fileSize > user.storageLimit) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    throw new Error('Storage limit exceeded');
  }

  // Generate unique object key inside MinIO
  const cleanName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const minioKey = `${owner}/${Date.now()}_${cleanName}`;

  let finalMimeType = mimeType;
  let finalKey = minioKey;

  // Verify name duplication inside the same folder for this owner
  const duplicate = await File.findOne({ name: originalName, folder: folderId, owner });
  if (duplicate) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    throw new Error(`A file named "${originalName}" is already uploaded in this folder.`);
  }
  const finalFileName = originalName;

  if (mimeType.startsWith('video/')) {
    const transcodeFolder = `hls_${Date.now()}`;
    const transcodeDir = path.join(__dirname, '../../temp-uploads', transcodeFolder);

    try {
      const { transcodeToHLS } = require('../utils/transcoder');
      await transcodeToHLS(filePath, transcodeDir);

      const cleanNameNoExt = cleanName.substring(0, cleanName.lastIndexOf('.')) || cleanName;
      const hlsPrefix = `${owner}/${Date.now()}_${cleanNameNoExt}`;

      const filesList = fs.readdirSync(transcodeDir);
      for (const fileItem of filesList) {
        const fileItemPath = path.join(transcodeDir, fileItem);
        const fileItemKey = `${hlsPrefix}/${fileItem}`;

        let itemMime = 'application/octet-stream';
        if (fileItem.endsWith('.m3u8')) itemMime = 'application/x-mpegURL';
        else if (fileItem.endsWith('.ts')) itemMime = 'video/MP2T';

        const itemMetaData = {
          'Content-Type': itemMime,
          'Owner-Id': owner,
        };

        await minioClient.fPutObject(bucketName, fileItemKey, fileItemPath, itemMetaData);
      }

      finalKey = `${hlsPrefix}/master.m3u8`;
      finalMimeType = 'application/x-mpegURL';

      fs.rmSync(transcodeDir, { recursive: true, force: true });
    } catch (err) {
      console.error('[Upload] Transcoding failed, falling back to raw video:', err);
      // Fallback upload
      const metaData = {
        'Content-Type': mimeType,
        'Original-Name': originalName,
        'Owner-Id': owner,
      };
      await minioClient.fPutObject(bucketName, minioKey, filePath, metaData);
      if (fs.existsSync(transcodeDir)) {
        fs.rmSync(transcodeDir, { recursive: true, force: true });
      }
    }
  } else {
    // Standard upload
    const metaData = {
      'Content-Type': mimeType,
      'Original-Name': originalName,
      'Owner-Id': owner,
    };
    await minioClient.fPutObject(bucketName, minioKey, filePath, metaData);
  }

  // Generate PDF thumbnail if applicable
  let thumbnailKey = null;
  if (mimeType === 'application/pdf') {
    try {
      const { pdfToPng } = require('pdf-to-png-converter');
      const pngPages = await pdfToPng(filePath, {
        pagesToProcess: [1],
        viewportScale: 1.0,
      });
      if (pngPages && pngPages.length > 0) {
        const pngBuffer = pngPages[0].content;
        thumbnailKey = `${owner}/thumbnails/${Date.now()}_thumb.png`;
        const thumbMetaData = {
          'Content-Type': 'image/png',
          'Owner-Id': owner,
        };
        await minioClient.putObject(bucketName, thumbnailKey, pngBuffer, pngBuffer.length, thumbMetaData);
      }
    } catch (pdfErr) {
      console.error('Failed to generate PDF thumbnail:', pdfErr);
    }
  }

  // Generate Video thumbnail if applicable
  if (mimeType.startsWith('video/')) {
    const thumbTempPath = path.join(__dirname, '../../temp-uploads', `video_thumb_${Date.now()}.png`);
    try {
      await extractVideoThumbnail(filePath, thumbTempPath);
      if (fs.existsSync(thumbTempPath)) {
        const pngBuffer = fs.readFileSync(thumbTempPath);
        thumbnailKey = `${owner}/thumbnails/${Date.now()}_thumb.png`;
        const thumbMetaData = {
          'Content-Type': 'image/png',
          'Owner-Id': owner,
        };
        await minioClient.putObject(bucketName, thumbnailKey, pngBuffer, pngBuffer.length, thumbMetaData);
        fs.unlinkSync(thumbTempPath);
      }
    } catch (videoErr) {
      console.error('Failed to generate video thumbnail:', videoErr);
      if (fs.existsSync(thumbTempPath)) fs.unlinkSync(thumbTempPath);
    }
  }

  // Save in DB
  const file = await File.create({
    name: finalFileName,
    key: finalKey,
    mimeType: finalMimeType,
    size: fileSize,
    folder: folderId,
    owner,
    thumbnailKey,
  });

  // Cleanup temp uploaded file safely
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  return file;
};

// Helper to merge chunks sequentially
const mergeChunks = (chunksDir, totalChunks, outputPath) => {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath);

    const appendChunk = (index) => {
      if (index === totalChunks) {
        writeStream.end();
        resolve();
        return;
      }
      const chunkPath = path.join(chunksDir, String(index));
      const readStream = fs.createReadStream(chunkPath);

      readStream.on('error', (err) => {
        writeStream.end();
        reject(err);
      });

      readStream.pipe(writeStream, { end: false });

      readStream.on('end', () => {
        appendChunk(index + 1);
      });
    };

    appendChunk(0);
  });
};

// 3. Upload a file (standard single file upload)
exports.uploadFile = async (req, res) => {
  try {
    const owner = req.user.id;
    const folderId = req.body.folderId && req.body.folderId !== 'null' ? req.body.folderId : null;

    if (!req.file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    const filePath = req.file.path;
    const fileSize = req.file.size;
    const originalName = decodeURIComponent(req.file.originalname);
    const mimeType = req.file.mimetype;

    const file = await processAndSaveUploadedFile(owner, folderId, filePath, fileSize, originalName, mimeType);
    return res.status(201).json(file);
  } catch (error) {
    console.error('Upload file error:', error);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ message: error.message || 'Server error during file upload' });
  }
};

// 3a. Get upload status for chunked uploads
exports.getUploadStatus = async (req, res) => {
  try {
    const { uploadId } = req.query;
    if (!uploadId) {
      return res.status(400).json({ message: 'uploadId is required' });
    }

    const chunksDir = path.join(__dirname, '../../temp-uploads', `chunks_${uploadId}`);
    if (fs.existsSync(chunksDir)) {
      const files = fs.readdirSync(chunksDir);
      const uploadedChunks = files.map(f => parseInt(f, 10)).filter(n => !isNaN(n));
      return res.json({ uploadedChunks });
    }

    return res.json({ uploadedChunks: [] });
  } catch (error) {
    console.error('Get upload status error:', error);
    return res.status(500).json({ message: 'Server error retrieving upload status' });
  }
};

// 3b. Cancel chunked upload and delete chunks folder
exports.cancelUpload = async (req, res) => {
  try {
    const { uploadId } = req.body;
    if (!uploadId) {
      return res.status(400).json({ message: 'uploadId is required' });
    }

    const chunksDir = path.join(__dirname, '../../temp-uploads', `chunks_${uploadId}`);
    if (fs.existsSync(chunksDir)) {
      fs.rmSync(chunksDir, { recursive: true, force: true });
    }

    return res.json({ message: 'Upload cancelled and chunks cleaned up successfully' });
  } catch (error) {
    console.error('Cancel upload error:', error);
    return res.status(500).json({ message: 'Server error cancelling upload' });
  }
};

// 3c. Upload a chunk
exports.uploadChunk = async (req, res) => {
  let tempFilePath = null;
  let chunksDir = null;
  try {
    const owner = req.user.id;
    const { uploadId, chunkIndex, totalChunks, fileName, folderId, mimeType, fileSize } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: 'No chunk file provided' });
    }

    tempFilePath = req.file.path;
    const chunkIdxInt = parseInt(chunkIndex, 10);
    const totalChunksInt = parseInt(totalChunks, 10);
    const folderIdNorm = folderId && folderId !== 'null' ? folderId : null;
    const fileSizeInt = parseInt(fileSize, 10);

    if (isNaN(chunkIdxInt) || isNaN(totalChunksInt)) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      return res.status(400).json({ message: 'chunkIndex and totalChunks must be valid integers' });
    }

    // Verify storage limit aggregate early
    if (!isNaN(fileSizeInt)) {
      const User = require('../models/User');
      const File = require('../models/File');
      const user = await User.findById(owner);
      if (user) {
        const existingFiles = await File.find({ owner });
        const usedStorage = existingFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);
        if (usedStorage + fileSizeInt > user.storageLimit) {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          return res.status(400).json({ message: `Storage limit exceeded. You only have ${((user.storageLimit - usedStorage) / (1024 * 1024)).toFixed(2)} MB remaining.` });
        }
      }
    }

    chunksDir = path.join(__dirname, '../../temp-uploads', `chunks_${uploadId}`);
    if (!fs.existsSync(chunksDir)) {
      fs.mkdirSync(chunksDir, { recursive: true });
    }

    const chunkPath = path.join(chunksDir, String(chunkIdxInt));
    // Move uploaded chunk file to chunks directory named by chunkIndex
    fs.renameSync(tempFilePath, chunkPath);

    // Read current uploaded chunk count
    const uploadedFiles = fs.readdirSync(chunksDir);
    const currentUploadedCount = uploadedFiles.filter(f => !isNaN(parseInt(f, 10))).length;

    // Check if we have received all chunks
    if (currentUploadedCount === totalChunksInt) {
      const mergedFileName = decodeURIComponent(fileName);
      const mergedFilePath = path.join(__dirname, '../../temp-uploads', `merged_${Date.now()}_${mergedFileName}`);

      // Merge chunks sequentially
      await mergeChunks(chunksDir, totalChunksInt, mergedFilePath);

      // Verify merged file exists and has size
      if (!fs.existsSync(mergedFilePath)) {
        throw new Error('Chunk merge failed, file not created.');
      }
      const fileSize = fs.statSync(mergedFilePath).size;

      // Process and save the fully merged file
      const file = await processAndSaveUploadedFile(
        owner,
        folderIdNorm,
        mergedFilePath,
        fileSize,
        mergedFileName,
        mimeType || 'application/octet-stream'
      );

      // Delete chunks directory after success
      fs.rmSync(chunksDir, { recursive: true, force: true });

      return res.status(201).json(file);
    }

    // Otherwise return progress acknowledgment
    return res.json({ message: `Chunk ${chunkIdxInt} uploaded successfully` });
  } catch (error) {
    console.error('Upload chunk error:', error);
    // Cleanup chunk file if it failed before rename
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
    return res.status(500).json({ message: error.message || 'Server error during chunk upload' });
  }
};

// 4. Delete file
exports.deleteFile = async (req, res) => {
  try {
    const { fileId } = req.params;
    const owner = req.user.id;

    const file = await File.findOne({ _id: fileId, owner });
    if (!file) {
      return res.status(404).json({ message: 'File not found or unauthorized' });
    }

    // Delete object(s) from MinIO
    if (file.mimeType === 'application/x-mpegURL') {
      const prefix = path.posix.dirname(file.key) + '/';
      const objectsList = [];
      const stream = minioClient.listObjectsV2(bucketName, prefix, true);

      await new Promise((resolve, reject) => {
        stream.on('data', (obj) => {
          objectsList.push(obj.name);
        });
        stream.on('error', (err) => reject(err));
        stream.on('end', async () => {
          try {
            if (objectsList.length > 0) {
              await minioClient.removeObjects(bucketName, objectsList);
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    } else {
      await minioClient.removeObject(bucketName, file.key);
    }

    // Delete thumbnail if it exists
    if (file.thumbnailKey) {
      await minioClient.removeObject(bucketName, file.thumbnailKey).catch(err => {
        console.warn('Failed to clean up thumbnail from MinIO:', err);
      });
    }

    // Delete any associated public Movie record
    const Movie = require('../models/Movie');
    const movie = await Movie.findOne({ videoKey: file.key });
    if (movie) {
      if (movie.posterKey && movie.posterKey !== file.thumbnailKey) {
        await minioClient.removeObject(bucketName, movie.posterKey).catch(err => {
          console.warn('Failed to clean up movie poster from MinIO:', err);
        });
      }
      await Movie.deleteOne({ _id: movie._id });
    }

    // Delete from DB
    await File.deleteOne({ _id: fileId });

    return res.json({ message: 'File deleted successfully', fileId });
  } catch (error) {
    console.error('Delete file error:', error);
    return res.status(500).json({ message: 'Server error deleting file' });
  }
};

// 5. Delete folder recursively (deletes all nested folders and files)
exports.deleteFolder = async (req, res) => {
  try {
    const { folderId } = req.params;
    const owner = req.user.id;

    const folder = await Folder.findOne({ _id: folderId, owner });
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found or unauthorized' });
    }

    // Recursive helper to gather all sub-folders and files
    const gatherAllFolderContents = async (currentId, foldersAccumulator, filesAccumulator) => {
      // Find sub-folders
      const subfolders = await Folder.find({ owner, parentFolder: currentId });
      for (const sub of subfolders) {
        foldersAccumulator.push(sub);
        await gatherAllFolderContents(sub._id, foldersAccumulator, filesAccumulator);
      }
      // Find files
      const files = await File.find({ owner, folder: currentId });
      for (const file of files) {
        filesAccumulator.push(file);
      }
    };

    const allFolders = [folder];
    const allFiles = [];

    await gatherAllFolderContents(folderId, allFolders, allFiles);

    // Delete MinIO objects
    if (allFiles.length > 0) {
      const keys = [];
      for (const f of allFiles) {
        if (f.mimeType === 'application/x-mpegURL') {
          const hlsKeys = await getHlsSubKeys(f.key);
          keys.push(...hlsKeys);
        } else {
          keys.push(f.key);
        }
        if (f.thumbnailKey && !keys.includes(f.thumbnailKey)) {
          keys.push(f.thumbnailKey);
        }
      }
      if (keys.length > 0) {
        await minioClient.removeObjects(bucketName, keys);
      }

      // Delete any associated public Movie records
      const fileKeys = allFiles.map(f => f.key);
      const Movie = require('../models/Movie');
      const movies = await Movie.find({ videoKey: { $in: fileKeys } });
      if (movies.length > 0) {
        for (const movie of movies) {
          if (movie.posterKey && !keys.includes(movie.posterKey)) {
            await minioClient.removeObject(bucketName, movie.posterKey).catch(err => {
              console.warn('Failed to clean up movie poster from MinIO:', err);
            });
          }
        }
        await Movie.deleteMany({ videoKey: { $in: fileKeys } });
      }

      // Delete files from DB
      const fileIds = allFiles.map(f => f._id);
      await File.deleteMany({ _id: { $in: fileIds } });
    }

    // Delete folders from DB
    const folderIds = allFolders.map(f => f._id);
    await Folder.deleteMany({ _id: { $in: folderIds } });

    return res.json({ message: 'Folder and all its contents deleted recursively', folderId });
  } catch (error) {
    console.error('Recursive delete folder error:', error);
    return res.status(500).json({ message: 'Server error deleting folder recursively' });
  }
};

// 5b. Get folder size recursively including all files
exports.getFolderSize = async (req, res) => {
  try {
    const { folderId } = req.params;
    const owner = req.user.id;

    const folder = await Folder.findOne({ _id: folderId, owner });
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found or unauthorized' });
    }

    // Recursive helper to gather all sub-folder IDs and sum file sizes
    const getFolderFilesSize = async (currentId) => {
      // Find sub-folders
      const subfolders = await Folder.find({ owner, parentFolder: currentId });
      let sizeSum = 0;
      for (const sub of subfolders) {
        sizeSum += await getFolderFilesSize(sub._id);
      }
      // Find files size sum
      const files = await File.find({ owner, folder: currentId }, 'size');
      const filesSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
      return sizeSum + filesSize;
    };

    const totalSize = await getFolderFilesSize(folderId);

    return res.json({ totalSize });
  } catch (error) {
    console.error('Get folder size error:', error);
    return res.status(500).json({ message: 'Server error getting folder size' });
  }
};

// 6. Stream/Download file with Range queries support
exports.streamFile = async (req, res) => {
  try {
    const { fileId, filename } = req.params;
    const owner = req.user.id; // User id verified from JWT token (query or headers)

    const file = await File.findOne({ _id: fileId, owner });
    if (!file) {
      return res.status(404).json({ message: 'File not found or unauthorized' });
    }

    if (file.mimeType === 'application/x-mpegURL' && filename) {
      // Stream sub-assets (HLS playlists and segment files)
      const baseDir = path.posix.dirname(file.key);
      const objectKey = path.posix.join(baseDir, filename);

      let itemMime = 'application/octet-stream';
      if (filename.endsWith('.m3u8')) itemMime = 'application/x-mpegURL';
      else if (filename.endsWith('.ts')) itemMime = 'video/MP2T';

      const dataStream = await minioClient.getObject(bucketName, objectKey);

      res.writeHead(200, {
        'Content-Type': itemMime,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      dataStream.on('error', (err) => {
        console.error('MinIO sub-asset stream read error:', err);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
      dataStream.pipe(res);
      return;
    }

    // Serve master playlist if HLS
    if (file.mimeType === 'application/x-mpegURL') {
      const dataStream = await minioClient.getObject(bucketName, file.key);

      res.writeHead(200, {
        'Content-Type': 'application/x-mpegURL',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      dataStream.on('error', (err) => {
        console.error('MinIO HLS master stream read error:', err);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
      dataStream.pipe(res);
      return;
    }

    const range = req.headers.range;

    if (range) {
      // Parse Range Header: e.g. "bytes=32324-" or "bytes=0-100"
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.size - 1;

      // Handle edge cases
      if (isNaN(start) || start < 0 || end >= file.size || start > end) {
        res.writeHead(416, {
          'Content-Range': `bytes */${file.size}`
        });
        return res.end();
      }

      const chunksize = (end - start) + 1;

      // Get partial object stream from MinIO
      const dataStream = await minioClient.getPartialObject(bucketName, file.key, start, chunksize);
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': file.mimeType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      dataStream.on('error', (err) => {
        console.error('MinIO stream read error (Range):', err);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });

      dataStream.pipe(res);
    } else {
      // Get full object stream from MinIO
      const dataStream = await minioClient.getObject(bucketName, file.key);

      // Return full file stream
      res.writeHead(200, {
        'Content-Length': file.size,
        'Content-Type': file.mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      dataStream.on('error', (err) => {
        console.error('MinIO stream read error (Full):', err);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });

      dataStream.pipe(res);
    }
  } catch (error) {
    console.error('File streaming proxy error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Server error streaming file' });
    }
  }
};

// 7. Simulated Subscription update
exports.updateSubscription = async (req, res) => {
  try {
    const owner = req.user.id;
    const { plan, billing } = req.body; // plan: 'free'|'silver'|'gold', billing: 'none'|'monthly'|'yearly'

    if (!['free', 'silver', 'gold', 'platinum'].includes(plan)) {
      return res.status(400).json({ message: 'Invalid plan selected' });
    }

    if (!['none', 'monthly', 'yearly'].includes(billing)) {
      return res.status(400).json({ message: 'Invalid billing option' });
    }

    let storageLimit = 3 * 1024 * 1024 * 1024; // 3GB free
    if (plan === 'silver') {
      storageLimit = 20 * 1024 * 1024 * 1024; // 20GB silver
    } else if (plan === 'gold') {
      storageLimit = 50 * 1024 * 1024 * 1024; // 50GB gold
    } else if (plan === 'platinum') {
      storageLimit = 100 * 1024 * 1024 * 1024; // 100GB platinum
    }

    // Set expiry date: 30 days for monthly, 365 days for yearly, null for free
    let expiresAt = null;
    if (billing === 'monthly') {
      expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else if (billing === 'yearly') {
      expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }

    const user = await User.findByIdAndUpdate(
      owner,
      {
        storageLimit,
        subscription: { plan, billing, expiresAt }
      },
      { new: true }
    ).select('-password');

    // Recalculate usage dynamically to return with user response
    const existingFiles = await File.find({ owner });
    const usedStorage = existingFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);

    return res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      storageLimit: user.storageLimit,
      subscription: user.subscription,
      usedStorage
    });
  } catch (error) {
    console.error('Update subscription plan error:', error);
    return res.status(500).json({ message: 'Server error updating subscription plan' });
  }
};

// 8. Update folder (rename / move)
exports.updateFolder = async (req, res) => {
  try {
    const { folderId } = req.params;
    const { name, parentFolderId } = req.body;
    const owner = req.user.id;

    const folder = await Folder.findOne({ _id: folderId, owner });
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found or unauthorized' });
    }

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ message: 'Folder name cannot be empty' });
      }

      // Check for duplicate folder name in target directory
      const targetParent = parentFolderId !== undefined ? (parentFolderId === 'null' ? null : parentFolderId) : folder.parentFolder;
      
      // Prevent naming a folder to its own name if it's in the same parent (no-op)
      if (trimmedName.toLowerCase() !== folder.name.toLowerCase() || targetParent !== folder.parentFolder) {
        const duplicate = await Folder.findOne({ name: trimmedName, parentFolder: targetParent, owner });
        if (duplicate) {
          return res.status(400).json({ message: 'A folder with this name already exists in the target directory' });
        }
      }
      folder.name = trimmedName;
    }

    if (parentFolderId !== undefined) {
      const targetParent = parentFolderId === 'null' || !parentFolderId ? null : parentFolderId;
      
      // Prevent moving a folder into itself
      if (targetParent && targetParent.toString() === folderId.toString()) {
        return res.status(400).json({ message: 'Cannot move a folder into itself' });
      }
      
      // Prevent moving a folder into one of its subfolders
      if (targetParent) {
        // Recursive check if targetParent is a subfolder of folderId
        const isSubfolder = async (childId, parentId) => {
          if (!childId) return false;
          const child = await Folder.findById(childId);
          if (!child) return false;
          if (child.parentFolder && child.parentFolder.toString() === parentId.toString()) {
            return true;
          }
          return await isSubfolder(child.parentFolder, parentId);
        };
        const invalidMove = await isSubfolder(targetParent, folderId);
        if (invalidMove) {
          return res.status(400).json({ message: 'Cannot move a folder into its own subfolder' });
        }
      }

      folder.parentFolder = targetParent;
    }

    await folder.save();
    return res.json(folder);
  } catch (error) {
    console.error('Update folder error:', error);
    return res.status(500).json({ message: 'Server error updating folder' });
  }
};

// 9. Update file (rename / move)
exports.updateFile = async (req, res) => {
  try {
    const { fileId } = req.params;
    const { name, folderId } = req.body;
    const owner = req.user.id;

    const file = await File.findOne({ _id: fileId, owner });
    if (!file) {
      return res.status(404).json({ message: 'File not found or unauthorized' });
    }

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ message: 'File name cannot be empty' });
      }

      const targetFolder = folderId !== undefined ? (folderId === 'null' ? null : folderId) : file.folder;

      if (trimmedName.toLowerCase() !== file.name.toLowerCase() || targetFolder !== file.folder) {
        const duplicate = await File.findOne({ name: trimmedName, folder: targetFolder, owner });
        if (duplicate) {
          return res.status(400).json({ message: 'A file with this name already exists in the target directory' });
        }
      }
      file.name = trimmedName;
    }

    if (folderId !== undefined) {
      const targetFolder = folderId === 'null' || !folderId ? null : folderId;
      file.folder = targetFolder;

      // Sync Movie folder reference
      const Movie = require('../models/Movie');
      await Movie.updateMany({ videoKey: file.key }, { folder: targetFolder });
    }

    await file.save();
    return res.json(file);
  } catch (error) {
    console.error('Update file error:', error);
    return res.status(500).json({ message: 'Server error updating file' });
  }
};

// 10. Stream file thumbnail
exports.streamThumbnail = async (req, res) => {
  try {
    const { fileId } = req.params;
    const owner = req.user.id;

    const file = await File.findOne({ _id: fileId, owner });
    if (!file || !file.thumbnailKey) {
      return res.status(404).json({ message: 'Thumbnail not found or unauthorized' });
    }

    const dataStream = await minioClient.getObject(bucketName, file.thumbnailKey);

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400', // Cache for 1 day
    });

    dataStream.on('error', (err) => {
      console.error('MinIO thumbnail stream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    dataStream.pipe(res);
  } catch (error) {
    console.error('Thumbnail streaming proxy error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Server error streaming thumbnail' });
    }
  }
};

// 11. Upload user profile avatar
exports.uploadAvatar = async (req, res) => {
  try {
    const owner = req.user.id;
    if (!req.file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    const filePath = req.file.path;
    const mimeType = req.file.mimetype;

    if (!mimeType.startsWith('image/')) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ message: 'Profile avatar must be an image file' });
    }

    const user = await User.findById(owner);
    if (!user) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(404).json({ message: 'User not found' });
    }

    // Clean up old avatar if exists
    if (user.avatarKey) {
      await minioClient.removeObject(bucketName, user.avatarKey).catch(err => {
        console.warn('Failed to clean up old avatar:', err);
      });
    }

    const cleanName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const avatarKey = `${owner}/avatar/${Date.now()}_${cleanName}`;

    // Upload to MinIO
    const metaData = {
      'Content-Type': mimeType,
      'Owner-Id': owner,
    };

    await minioClient.fPutObject(bucketName, avatarKey, filePath, metaData);

    // Cleanup temp file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Update User in DB
    user.avatarKey = avatarKey;
    await user.save();

    // Recalculate storage metrics to return full user object
    const existingFiles = await File.find({ owner });
    const usedStorage = existingFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);

    return res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      storageLimit: user.storageLimit,
      subscription: user.subscription,
      avatarKey: user.avatarKey,
      usedStorage
    });
  } catch (error) {
    console.error('Upload avatar error:', error);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ message: 'Server error during avatar upload' });
  }
};

// 12. Stream user profile avatar
exports.streamAvatar = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user || !user.avatarKey) {
      return res.status(404).json({ message: 'Avatar not found or not uploaded' });
    }

    const dataStream = await minioClient.getObject(bucketName, user.avatarKey);

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400', // Cache for 1 day
    });

    dataStream.on('error', (err) => {
      console.error('MinIO avatar stream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    dataStream.pipe(res);
  } catch (error) {
    console.error('Avatar streaming proxy error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Server error streaming profile avatar' });
    }
  }
};

