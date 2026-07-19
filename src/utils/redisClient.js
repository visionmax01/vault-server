const { createClient } = require('redis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let client = null;
let isRedisConnected = false;

const initRedis = async () => {
  let connectionWarningPrinted = false;
  let hasConnectedOnce = false;

  try {
    console.log(`Connecting to Redis at ${redisUrl}...`);
    client = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          // If we never successfully connected, fail fast to avoid startup console spam
          if (!hasConnectedOnce) {
            if (!connectionWarningPrinted) {
              console.warn('[Redis Alert] Redis server is not running locally. Gracefully falling back to direct MongoDB queries.');
              connectionWarningPrinted = true;
            }
            return false;
          }
          // If we lost an active connection, retry up to 5 times
          if (retries > 5) {
            console.warn('[Redis] Reconnection limit reached. Fallback to direct DB queries.');
            return false;
          }
          return 5000;
        }
      }
    });

    client.on('error', (err) => {
      // Only log errors if we actually connected once, avoiding startup connection noise
      if (hasConnectedOnce) {
        console.warn('[Redis Error] Connection lost:', err.message);
      }
      isRedisConnected = false;
    });

    client.on('connect', () => {
      // Silent on initial connection attempt
    });

    client.on('ready', () => {
      console.log('[Redis Client] Connected and ready successfully.');
      isRedisConnected = true;
      hasConnectedOnce = true;
    });

    await client.connect();
  } catch (error) {
    if (!connectionWarningPrinted) {
      console.warn('[Redis Alert] Redis connection failed. Running in fallback mode (direct DB queries).');
    }
    isRedisConnected = false;
  }
};

const getCache = async (key) => {
  if (!isRedisConnected || !client) return null;
  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.warn('[Redis getCache error]:', error.message);
    return null;
  }
};

const setCache = async (key, data, ttlSeconds = 3600) => {
  if (!isRedisConnected || !client) return false;
  try {
    await client.set(key, JSON.stringify(data), {
      EX: ttlSeconds
    });
    return true;
  } catch (error) {
    console.warn('[Redis setCache error]:', error.message);
    return false;
  }
};

const deleteCache = async (key) => {
  if (!isRedisConnected || !client) return false;
  try {
    await client.del(key);
    return true;
  } catch (error) {
    console.warn('[Redis deleteCache error]:', error.message);
    return false;
  }
};

/**
 * Invalidates cache for a specific folder content listing
 */
const invalidateFolderCache = async (owner, folderId) => {
  if (!isRedisConnected || !client) return false;
  try {
    const targetFolder = folderId || 'root';
    const directKey = `vault:content:${owner}:${owner}:${targetFolder}`;
    await client.del(directKey);

    const pattern = `vault:content:*:${targetFolder}`;
    let cursor = 0;
    do {
      const reply = await client.scan(cursor, {
        MATCH: pattern,
        COUNT: 100
      });
      cursor = reply.cursor;
      const keys = reply.keys;
      if (keys.length > 0) {
        await client.del(keys);
        console.log(`[Redis Cache Invalidate] Cleared ${keys.length} keys for folder: ${targetFolder}`);
      }
    } while (cursor !== 0);
    return true;
  } catch (error) {
    console.warn('[Redis invalidateFolderCache error]:', error.message);
    return false;
  }
};

/**
 * Invalidates all cache entries for a user by scanning keys
 */
const invalidateAllUserCache = async (owner) => {
  if (!isRedisConnected || !client) return false;
  try {
    const patterns = [`vault:content:${owner}:*`, `vault:content:*:${owner}:*`];
    for (const pattern of patterns) {
      let cursor = 0;
      do {
        const reply = await client.scan(cursor, {
          MATCH: pattern,
          COUNT: 100
        });
        cursor = reply.cursor;
        const keys = reply.keys;
        if (keys.length > 0) {
          await client.del(keys);
          console.log(`[Redis Cache Invalidate] Cleared ${keys.length} keys matching pattern ${pattern}`);
        }
      } while (cursor !== 0);
    }
    return true;
  } catch (error) {
    console.warn('[Redis invalidateAllUserCache error]:', error.message);
    return false;
  }
};

module.exports = {
  initRedis,
  getCache,
  setCache,
  deleteCache,
  invalidateFolderCache,
  invalidateAllUserCache,
  isRedisConnected: () => isRedisConnected
};
