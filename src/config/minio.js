const Minio = require('minio');
require('dotenv').config();

const useSSL = process.env.MINIO_USE_SSL === 'true';
const portStr = process.env.MINIO_PORT;
let port = undefined;
if (portStr) {
  const parsedPort = parseInt(portStr, 10);
  if (parsedPort !== 80 && parsedPort !== 443) {
    port = parsedPort;
  }
}

const rawEndPoint = process.env.MINIO_ENDPOINT || 'localhost';
const endPoint = rawEndPoint.replace(/^https?:\/\//i, '').split('/')[0].trim();
const isLocalhost = endPoint === 'localhost' || endPoint === '127.0.0.1';

const minioClient = new Minio.Client({
  endPoint,
  port,
  useSSL,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  region: process.env.MINIO_REGION || undefined,
  pathStyle: !isLocalhost,
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
