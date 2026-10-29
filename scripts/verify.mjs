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

async function verify() {
  console.log('--- Flash Sale Consistency Audit ---');

  const client = await pgPool.connect();
  try {
    const invRes = await client.query("SELECT stock FROM inventory WHERE product_id = 'phone-1'");
    const orderCountRes = await client.query("SELECT COUNT(*) AS total FROM orders WHERE product_id = 'phone-1'");
    const statusBreakdown = await client.query(
      "SELECT status, COUNT(*) AS count FROM orders WHERE product_id = 'phone-1' GROUP BY status"
    );

    const pgStock = invRes.rows[0]?.stock ?? 'N/A';
    const pgOrders = parseInt(orderCountRes.rows[0]?.total || '0', 10);

    const redisStock = await redis.get('stock:phone-1');
    const redisBuyers = await redis.scard('buyers:phone-1');
    const streamLen = await redis.xlen('stream:orders');

    console.log(`PostgreSQL Stock Remaining: ${pgStock}`);
    console.log(`PostgreSQL Orders Inserted: ${pgOrders}`);
    console.log('PostgreSQL Status Breakdown:', statusBreakdown.rows);
    console.log(`Redis In-Memory Stock:      ${redisStock}`);
    console.log(`Redis Buyers Set Size:      ${redisBuyers}`);
    console.log(`Redis Stream Events:        ${streamLen}`);

    console.log('\n--- Invariant Verification ---');
    const isOrdersExact500 = pgOrders === 500;
    const isStockZero = pgStock === 0 && redisStock === '0';
    const isBuyersExact500 = redisBuyers === 500;

    console.log(`[Rule 1] Exactly 500 orders created: ${isOrdersExact500 ? 'PASS (500)' : `FAIL (${pgOrders})`}`);
    console.log(`[Rule 2] Remaining stock is 0:        ${isStockZero ? 'PASS (0)' : `FAIL (PG:${pgStock}, Redis:${redisStock})`}`);
    console.log(`[Rule 3] Buyers set matches orders:   ${isBuyersExact500 ? 'PASS (500)' : `FAIL (${redisBuyers})`}`);

    if (isOrdersExact500 && isStockZero && isBuyersExact500) {
      console.log('\nRESULT: ZERO OVERSELLING. Exact invariant holds under concurrent load.');
    } else {
      console.log('\nRESULT: INVARIANT VIOLATION DETECTED.');
    }
  } finally {
    client.release();
    await pgPool.end();
    redis.disconnect();
  }
}

verify().catch(console.error);