const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const vaultRoutes = require('./routes/vault');
const adminRoutes = require('./routes/admin');
const movieRoutes = require('./routes/movies');
const { initMinio } = require('./config/minio');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for specified origins (including port 8082 by IP/localhost)
const allowedOrigins = [
  'http://localhost:8082',
  'http://localhost:3000',
  'http://127.0.0.1:8082',
  'http://192.168.1.111:8082',
  'http://10.0.2.2:8082'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || /:8082$/.test(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true
}));

// Body parser with raw body verifier for Stripe webhooks signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/payment/webhook')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// Log requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Setup api routes
const paymentRoutes = require('./routes/payment');
app.use('/api/auth', authRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/movies', movieRoutes);
app.use('/api/payment', paymentRoutes);

// Health check API
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    dbState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    message: 'Vault Storage Service is running and healthy'

  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(err.status || 500).json({
    message: err.message || 'An unexpected server error occurred',
  });
});

// Connect to MongoDB and start Server
const startServer = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/vault';
    console.log(`Connecting to MongoDB at ${mongoUri.replace(/:([^:@]+)@/, ':****@')}...`);
    
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('MongoDB database connected successfully.');

    // Drop old unique indexes to prevent conflict with updated schemas
    try {
      const File = require('./models/File');
      const Folder = require('./models/Folder');
      await File.collection.dropIndex('name_1_folder_1_owner_1').catch(() => {});
      await Folder.collection.dropIndex('name_1_parentFolder_1_owner_1').catch(() => {});
      console.log('Successfully dropped old unique indexes (if any) to sync with soft-delete schema.');
    } catch (indexErr) {
      console.warn('Index drop warning (non-fatal):', indexErr.message);
    }

    // Initialize Redis client layer
    try {
      const { initRedis } = require('./utils/redisClient');
      await initRedis();
    } catch (redisErr) {
      console.warn('Redis connection issue (gracefully skipped):', redisErr.message);
    }

    // Initialize MinIO Bucket
    console.log('Initializing MinIO configuration...');
    await initMinio();

    // Start Express Listener
    const serverInstance = app.listen(PORT, '0.0.0.0', () => {
      console.log(`===================================================`);
      console.log(`Vault Storage Service started on port ${PORT}`);
      console.log(`API URL: http://localhost:${PORT}`);
      console.log(`===================================================`);
    });

    // Initialize WebSockets
    const { initSockets } = require('./sockets');
    initSockets(serverInstance);

    // Initialize Trash Auto-Delete Worker
    const { initTrashWorker } = require('./utils/trashWorker');
    initTrashWorker();
  } catch (error) {
    console.error('Fatal initialization error, server stopping:', error);
    process.exit(1);
  }
};

startServer();
