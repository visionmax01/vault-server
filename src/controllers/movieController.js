const Movie = require('../models/Movie');
const { minioClient, bucketName } = require('../config/minio');
const path = require('path');

// 1. List all public movies grouped by parent folder
exports.listMovies = async (req, res) => {
  try {
    const movies = await Movie.find({}).populate('folder').sort({ createdAt: 1 });
    
    // Group movies by parent folder
    const folderGroups = {};
    movies.forEach((movie) => {
      if (!movie.folder) return; // skip if no folder reference
      const fId = movie.folder._id.toString();
      if (!folderGroups[fId]) {
        folderGroups[fId] = {
          _id: fId,
          title: movie.folder.name,
          category: movie.category,
          mediaType: movie.mediaType,
          posterKey: movie.posterKey,
          createdAt: movie.folder.createdAt,
          parts: []
        };
      }
      folderGroups[fId].parts.push(movie);
    });

    // Convert to array and sort by folder creation date (newest folders first)
    const catalog = Object.values(folderGroups).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json(catalog);
  } catch (error) {
    console.error('List movies error:', error);
    return res.status(500).json({ message: 'Server error listing movies catalog' });
  }
};

// 2. Stream movie video bytes (with partial content/range seek support)
exports.streamMovie = async (req, res) => {
  try {
    const { movieId, filename } = req.params;

    // Check user subscription plan (block 'free' and 'silver')
    const userPlan = req.user?.plan || 'free';
    if (userPlan === 'free' || userPlan === 'silver') {
      return res.status(403).json({
        message: 'Upgrade required. Please upgrade your subscription plan to Gold or Platinum to stream video content.',
        upgradeRequired: true
      });
    }

    const movie = await Movie.findById(movieId);
    if (!movie) {
      return res.status(404).json({ message: 'Movie not found' });
    }

    if (movie.mimeType === 'application/x-mpegURL' && filename) {
      // Stream sub-assets (HLS playlists and segment files)
      const baseDir = path.posix.dirname(movie.videoKey);
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
        console.error('MinIO movie sub-asset stream error:', err);
        if (!res.headersSent) res.status(500).end();
      });
      dataStream.pipe(res);
      return;
    }

    // Serve master playlist if HLS
    if (movie.mimeType === 'application/x-mpegURL') {
      const dataStream = await minioClient.getObject(bucketName, movie.videoKey);

      res.writeHead(200, {
        'Content-Type': 'application/x-mpegURL',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      dataStream.on('error', (err) => {
        console.error('MinIO movie HLS master stream error:', err);
        if (!res.headersSent) res.status(500).end();
      });
      dataStream.pipe(res);
      return;
    }

    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : movie.size - 1;

      if (isNaN(start) || start < 0 || end >= movie.size || start > end) {
        res.writeHead(416, {
          'Content-Range': `bytes */${movie.size}`
        });
        return res.end();
      }

      const chunksize = (end - start) + 1;

      const dataStream = await minioClient.getPartialObject(bucketName, movie.videoKey, start, chunksize);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${movie.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': movie.mimeType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      dataStream.on('error', (err) => {
        console.error('MinIO movie stream error (Range):', err);
        if (!res.headersSent) res.status(500).end();
      });
      dataStream.pipe(res);
    } else {
      const dataStream = await minioClient.getObject(bucketName, movie.videoKey);

      res.writeHead(200, {
        'Content-Length': movie.size,
        'Content-Type': movie.mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      dataStream.on('error', (err) => {
        console.error('MinIO movie stream error (Full):', err);
        if (!res.headersSent) res.status(500).end();
      });
      dataStream.pipe(res);
    }
  } catch (error) {
    console.error('Stream movie error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Server error streaming movie' });
    }
  }
};

// 3. Stream movie poster image
exports.streamPoster = async (req, res) => {
  try {
    const { movieId } = req.params;

    const movie = await Movie.findById(movieId);
    if (!movie || !movie.posterKey) {
      return res.status(404).json({ message: 'Movie poster not found' });
    }

    // Determine content type based on extension
    const ext = movie.posterKey.split('.').pop().toLowerCase();
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';

    const dataStream = await minioClient.getObject(bucketName, movie.posterKey);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400', // Cache for 1 day
    });

    dataStream.on('error', (err) => {
      console.error('MinIO poster stream error:', err);
      if (!res.headersSent) res.status(500).end();
    });
    dataStream.pipe(res);
  } catch (error) {
    console.error('Stream poster error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Server error streaming movie poster' });
    }
  }
};

// 4. Search all movies and series
exports.searchMovies = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.json([]);
    }

    const regex = new RegExp(q, 'i');
    
    // Import Folder model dynamically
    const Folder = require('../models/Folder');
    
    // Find folders that match the query name
    const matchingFolders = await Folder.find({ name: regex });
    const matchingFolderIds = matchingFolders.map(f => f._id);

    // Find movies matching title, category, mediaType, or folder
    const movies = await Movie.find({
      $or: [
        { title: regex },
        { category: regex },
        { mediaType: regex },
        { folder: { $in: matchingFolderIds } }
      ]
    }).populate('folder').sort({ createdAt: 1 });

    // Group matching movies by parent folder
    const folderGroups = {};
    movies.forEach((movie) => {
      if (!movie.folder) return; // skip if no folder reference
      const fId = movie.folder._id.toString();
      if (!folderGroups[fId]) {
        folderGroups[fId] = {
          _id: fId,
          title: movie.folder.name,
          category: movie.category,
          mediaType: movie.mediaType,
          posterKey: movie.posterKey,
          createdAt: movie.folder.createdAt,
          parts: []
        };
      }
      folderGroups[fId].parts.push(movie);
    });

    const results = Object.values(folderGroups);
    return res.json(results);
  } catch (error) {
    console.error('Search movies error:', error);
    return res.status(500).json({ message: 'Server error searching movies' });
  }
};
