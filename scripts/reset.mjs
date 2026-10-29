import pg from 'pg';
import { Redis } from 'ioredis';

const { Pool } = pg;

const pgPool = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgrespassword',
  database: process.env.PG_DATABASE || 'flashsale_db',
});

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
});

async function resetSystem(stockCount = 500) {
  console.log(`[Reset] Resetting system to stock = ${stockCount}...`);

  // Step 1: Reset Postgres inventory and wipe orders
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO inventory (product_id, stock)
       VALUES ('phone-1', $1)
       ON CONFLICT (product_id) DO UPDATE SET stock = $1`,
      [stockCount]
    );
    await client.query("DELETE FROM orders WHERE product_id = 'phone-1'");
    await client.query('COMMIT');
    console.log(`[Reset] PostgreSQL: inventory reset to ${stockCount}, orders wiped.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Step 2: Reset Redis stock, buyers set, and delete stream + order keys
  await redis.set('stock:phone-1', stockCount);
  await redis.del('buyers:phone-1');
  await redis.del('stream:orders');

  // Find and delete leftover order hash keys
  const orderKeys = await redis.keys('order:*');
  if (orderKeys.length > 0) {
    await redis.del(...orderKeys);
  }

  console.log(`[Reset] Redis: stock:phone-1 set to ${stockCount}, keys purged.`);

  await pgPool.end();
  redis.disconnect();
  console.log('[Reset] System state clean and ready for test.\n');
}

const targetStock = process.argv[2] ? parseInt(process.argv[2], 10) : 500;
resetSystem(targetStock).catch((err) => {
  console.error('[Reset] Failed:', err);
  process.exit(1);
});