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
});

// Reclaim Lua script: restores stock and removes buyer from set
const reclaimLua = `
  redis.call('INCR', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[1])
  redis.call('HSET', KEYS[3], 'status', 'EXPIRED')
  return 1
`;

async function expireUnpaidOrders(expiryMinutes = 10) {
  console.log(`[Expiry Job] Scanning for orders pending > ${expiryMinutes} minutes...`);
  const client = await pgPool.connect();

  try {
    // 1. Find orders stuck in PENDING status past cutoff
    const res = await client.query(
      `SELECT order_id, user_id, product_id 
       FROM orders 
       WHERE status = 'PENDING' 
         AND created_at < NOW() - ($1 || ' minutes')::INTERVAL`,
      [expiryMinutes]
    );

    if (res.rows.length === 0) {
      console.log('[Expiry Job] No expired reservations found.');
      return;
    }

    console.log(`[Expiry Job] Expiring ${res.rows.length} order(s)...`);

    for (const order of res.rows) {
      await client.query('BEGIN');

      // 2. Increment DB stock
      await client.query(
        'UPDATE inventory SET stock = stock + 1 WHERE product_id = $1',
        [order.product_id]
      );

      // 3. Update order status to EXPIRED
      await client.query(
        "UPDATE orders SET status = 'EXPIRED' WHERE order_id = $1",
        [order.order_id]
      );

      await client.query('COMMIT');

      // 4. Atomically restore Redis stock & remove user from buyers set
      await redis.eval(
        reclaimLua,
        3,
        `stock:${order.product_id}`,
        `buyers:${order.product_id}`,
        `order:${order.order_id}`,
        order.user_id
      );

      console.log(`[Expiry Job] Reclaimed stock for order ${order.order_id}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Expiry Job] Error during reclaim:', err);
  } finally {
    client.release();
    await pgPool.end();
    redis.disconnect();
  }
}

// Test with short expiry cutoff (e.g., 0.01 minutes / 1 second for local verification)
const cutoff = process.argv[2] ? parseFloat(process.argv[2]) : 10;
expireUnpaidOrders(cutoff);