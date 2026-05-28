import Redis from 'ioredis';
import { config } from '../config.js';

const memoryCache = new Map();
let redis = null;
let redisReady = false;
let redisWarned = false;

const STALE_GRACE_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60_000;
const MAX_REDIS_MEMORY_TTL = 300;
let redisConnectPromise = null;

function readMemory(key) {
  const item = memoryCache.get(key);
  if (!item) return { value: null, stale: false };

  const now = Date.now();
  if (item.expiresAt <= now) {
    if (item.expiresAt + STALE_GRACE_MS > now) {
      return { value: item.value, stale: true };
    }
    memoryCache.delete(key);
    return { value: null, stale: false };
  }

  return { value: item.value, stale: false };
}

function writeMemory(key, value, ttlSeconds) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });

  if (memoryCache.size > config.cache.memoryMaxItems) {
    const deleteCount = Math.max(1, Math.floor(config.cache.memoryMaxItems * 0.1));
    const it = memoryCache.keys();
    for (let i = 0; i < deleteCount; i++) {
      const r = it.next();
      if (r.done) break;
      memoryCache.delete(r.value);
    }
  }
}

function cleanupExpired() {
  const now = Date.now();
  const graceEnd = now - STALE_GRACE_MS;
  for (const [key, item] of memoryCache) {
    if (item.expiresAt < graceEnd) {
      memoryCache.delete(key);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

function createRedisClient() {
  if (!config.cache.redisUrl) return null;

  const client = new Redis(config.cache.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1500,
    commandTimeout: 1500,
    retryStrategy: (times) => (times > 2 ? null : Math.min(times * 250, 1000)),
  });

  client.on('ready', () => {
    redisReady = true;
    redisWarned = false;
  });

  client.on('close', () => {
    redisReady = false;
  });

  client.on('error', (err) => {
    redisReady = false;
    if (!redisWarned) {
      console.warn('[Redis] unavailable; using in-memory cache fallback:', err.message);
      redisWarned = true;
    }
  });

  return client;
}

redis = createRedisClient();

async function ensureRedis() {
  if (!redis) return null;
  if (redisReady) return redis;
  if (redisConnectPromise) return redisConnectPromise;

  redisConnectPromise = redis.connect()
    .then(() => redis)
    .catch(() => null)
    .finally(() => {
      redisConnectPromise = null;
    });

  return redisConnectPromise;
}

export async function getCache(key) {
  const { value: memoryValue, stale } = readMemory(key);
  if (memoryValue !== null && !stale) return memoryValue;

  const client = await ensureRedis();
  if (client) {
    try {
      const data = await client.get(key);
      if (data) {
        const parsed = JSON.parse(data);
        writeMemory(key, parsed, Math.min(config.cache.ttlSeconds, MAX_REDIS_MEMORY_TTL));
        return parsed;
      }
    } catch {
      // fall through
    }
  }

  if (memoryValue !== null) return memoryValue;
  return null;
}

export async function setCache(key, value, ttl = config.cache.ttlSeconds) {
  writeMemory(key, value, ttl);

  const client = await ensureRedis();
  if (!client) return;

  try {
    await client.set(key, JSON.stringify(value), 'EX', ttl);
  } catch {
    // Redis is optional
  }
}

export async function closeRedis() {
  clearInterval(cleanupTimer);

  if (!redis) return;

  try {
    if (redis.status === 'ready' || redis.status === 'connect') await redis.quit();
    else redis.disconnect();
  } catch {
    redis.disconnect();
  }
}

export function getCacheStatus() {
  return {
    memoryItems: memoryCache.size,
    redisEnabled: Boolean(redis),
    redisReady,
  };
}
