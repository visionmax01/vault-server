const Minio = require('minio');
require('dotenv').config();

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  region: process.env.MINIO_REGION || undefined,
});

const bucketName = process.env.MINIO_BUCKET || 'vault-files';

// Initialize bucket on startup
const initMinio = async () => {
  try {
    const exists = await minioClient.bucketExists(bucketName);
    if (exists) {
      console.log(`MinIO bucket "${bucketName}" already exists.`);
    } else {
      await minioClient.makeBucket(bucketName, process.env.MINIO_REGION || 'us-east-1');
      console.log(`MinIO bucket "${bucketName}" created successfully.`);
    }
  } catch (error) {
    console.error('Failed to initialize MinIO bucket:', error);
    // Exit process on critical startup failure
    process.exit(1);
  }
};

module.exports = {
  minioClient,
  bucketName,
  initMinio,
};
