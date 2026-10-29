import { pgPool, redis } from './db.js';

const STREAM_KEY = 'stream:orders';
const GROUP_NAME = 'orders_group';
const CONSUMER_NAME = `worker-${process.pid}`;

// Convert raw flat array from Redis Streams to key-value record
function parseStreamFields(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    result[fields[i]] = fields[i + 1];
  }
  return result;
}

// Ensure the Consumer Group exists before reading
async function setupConsumerGroup() {
  try {
    // '$' reads only new messages; '0' would process existing stream history
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
    console.log(`[Worker] Consumer group '${GROUP_NAME}' created`);
  } catch (err: any) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`[Worker] Consumer group '${GROUP_NAME}' already exists`);
    } else {
      throw err;
    }
  }
}

async function processOrderMessage(messageId: string, fields: Record<string, string>) {
  const { order_id, user_id, product_id, idem_key } = fields;

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: Conditional atomic update - check stock > 0 at DB level
    const updateRes = await client.query(
      'UPDATE inventory SET stock = stock - 1 WHERE product_id = $1 AND stock > 0',
      [product_id]
    );

    if (updateRes.rowCount === 0) {
      // Postgres stock is exhausted: rollback and mark FAILED
      await client.query('ROLLBACK');
      await redis.hset(`order:${order_id}`, 'status', 'FAILED', 'reason', 'DB_STOCK_EMPTY');
      await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
      console.warn(`[Worker] Stock was zero in DB for order ${order_id}`);
      return;
    }

    // Step 2: Insert order idempotently with ON CONFLICT DO NOTHING
    await client.query(
      `INSERT INTO orders (order_id, user_id, product_id, idem_key, status)
       VALUES ($1, $2, $3, $4, 'CONFIRMED')
       ON CONFLICT (idem_key) DO NOTHING`,
      [order_id, user_id, product_id, idem_key]
    );

    await client.query('COMMIT');

    // Step 3: Update Redis order status to CONFIRMED
    await redis.hset(`order:${order_id}`, 'status', 'CONFIRMED');

    // Step 4: Acknowledge message only after DB commit succeeds
    await redis.xack(STREAM_KEY, GROUP_NAME, messageId);

    console.log(`[Worker] Order ${order_id} confirmed for user ${user_id}`);
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error(`[Worker] Failed processing order ${order_id}:`, err.message);
    // Note: If an unhandled DB crash occurs, the message is NOT acked.
    // It stays in the Pending Entries List (PEL) for retry.
  } finally {
    client.release();
  }
}

async function startConsumer() {
  await setupConsumerGroup();
  console.log(`[Worker] Consumer ${CONSUMER_NAME} started listening for orders...`);

  while (true) {
    try {
      // Read new messages assigned to this consumer group (BLOCK 2000ms)
      const response = await redis.xreadgroup(
        'GROUP',
        GROUP_NAME,
        CONSUMER_NAME,
        'BLOCK',
        2000,
        'COUNT',
        10,
        'STREAMS',
        STREAM_KEY,
        '>'
      ) as [string, [string, string[]][]][] | null;

      if (!response || response.length === 0) {
        continue;
      }

      for (const [_, messages] of response) {
        for (const [messageId, rawFields] of messages) {
          const fields = parseStreamFields(rawFields);
          await processOrderMessage(messageId, fields);
        }
      }
    } catch (err: any) {
      console.error('[Worker] Consumer loop error:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

startConsumer().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});