import pg from 'pg';
import { Redis } from 'ioredis';

const { Pool } = pg;

const redisHost = process.env.REDIS_HOST?.trim() || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

export const pgPool = new Pool({
  host: process.env.PG_HOST?.trim() || '127.0.0.1',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgrespassword',
  database: process.env.PG_DATABASE || 'flashsale_db',
  max: 20,
  idleTimeoutMillis: 10000,
});

export const redis = new Redis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: null,
  retryStrategy(times: number) {
    return Math.min(times * 100, 2000);
  },
});

redis.on('connect', () => {
  console.log(`[Worker] Connected to Redis at ${redisHost}:${redisPort}`);
});

redis.on('error', (err: Error) => {
  console.error('[Worker] Redis error:', err.message);
});