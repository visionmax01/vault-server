const crypto = require('crypto');
const fs = require('fs');

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_SECRET = 'vault_master_secret_key_32bytes_long!!_2026';

const getMasterSecret = () => {
  return process.env.ENCRYPTION_SECRET || DEFAULT_SECRET;
};

/**
 * Derives a deterministic 32-byte AES key per user using PBKDF2
 */
const deriveKey = (userId) => {
  const salt = String(userId || 'default_user_salt');
  return crypto.pbkdf2Sync(getMasterSecret(), salt, 100000, 32, 'sha256');
};

/**
 * Encrypts a file on disk from inputPath to outputPath using AES-256-GCM
 * Returns { iv: string (hex), authTag: string (hex) }
 */
const encryptFile = (inputPath, outputPath, key) => {
  return new Promise((resolve, reject) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath);

    input.pipe(cipher).pipe(output);

    output.on('finish', () => {
      const authTag = cipher.getAuthTag();
      resolve({
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
      });
    });

    input.on('error', reject);
    output.on('error', reject);
    cipher.on('error', reject);
  });
};

/**
 * Creates a Decryption Decipher Transform Stream
 */
const createDecryptionStream = (key, ivHex, authTagHex) => {
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher;
};

/**
 * Encrypts an in-memory buffer using AES-256-GCM
 * Returns { encryptedBuffer, iv: string (hex), authTag: string (hex) }
 */
const encryptBuffer = (buffer, key) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encryptedBuffer = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedBuffer,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
};

/**
 * Decrypts an in-memory buffer using AES-256-GCM
 */
const decryptBuffer = (encryptedBuffer, key, ivHex, authTagHex) => {
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
};

module.exports = {
  deriveKey,
  encryptFile,
  createDecryptionStream,
  encryptBuffer,
  decryptBuffer,
};
