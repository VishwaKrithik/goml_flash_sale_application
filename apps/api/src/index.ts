import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgPool, redis } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({
  logger: false,
  trustProxy: true, // Crucial: reads real client IP from X-Forwarded-For
});

await app.register(cors, { origin: true });

// Environment toggle for load testing
const isRateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== 'false';

// Register per-user rate limit using Redis store
if (isRateLimitEnabled) {
  await app.register(rateLimit, {
    global: false,
    redis: redis,
    max: 5,
    timeWindow: '10 seconds',
    keyGenerator: (req) => {
      // Key rate limit by x-user-id header, fallback to IP
      return (req.headers['x-user-id'] as string) || req.ip;
    },
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Per-user rate limit exceeded: max 5 requests per 10 seconds',
    }),
  });
}

// Load Lua script from filesystem (checks dist/lua or src/lua)
let luaPath = path.join(__dirname, 'lua', 'reserve_stock.lua');
if (!fs.existsSync(luaPath)) {
  luaPath = path.join(__dirname, '..', 'src', 'lua', 'reserve_stock.lua');
}
const reserveStockLua = fs.readFileSync(luaPath, 'utf8');

redis.defineCommand('reserveStock', {
  numberOfKeys: 4,
  lua: reserveStockLua,
});

declare module 'ioredis' {
  interface RedisCommander<Context> {
    reserveStock(
      stockKey: string,
      buyersKey: string,
      orderKey: string,
      streamKey: string,
      userId: string,
      productId: string,
      orderId: string,
      idemKey: string
    ): Promise<number>;
  }
}

// Identify which container replica served the request
app.addHook('onSend', async (request, reply) => {
  reply.header('X-Served-By', process.env.HOSTNAME || 'localhost');
});

/**
 * FIXED ENDPOINT: POST /checkout
 * Protected by per-user rate limit if enabled.
 */
app.post(
  '/checkout',
  {
    config: {
      rateLimit: isRateLimitEnabled
        ? {
            max: 5,
            timeWindow: '10 seconds',
          }
        : false,
    },
  },
  async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    const idemKey = request.headers['idempotency-key'] as string;

    if (!userId) {
      return reply.status(400).send({ error: 'MISSING_X_USER_ID_HEADER' });
    }

    if (!idemKey) {
      return reply.status(400).send({ error: 'MISSING_IDEMPOTENCY_KEY_HEADER' });
    }

    const productId = 'phone-1';
    const orderId = uuidv4();

    const stockKey = `stock:${productId}`;
    const buyersKey = `buyers:${productId}`;
    const orderKey = `order:${orderId}`;
    const streamKey = 'stream:orders';

    try {
      const result = await redis.reserveStock(
        stockKey,
        buyersKey,
        orderKey,
        streamKey,
        userId,
        productId,
        orderId,
        idemKey
      );

      if (result === -1) {
        return reply.status(409).send({ error: 'ALREADY_PURCHASED' });
      }

      if (result === 0) {
        return reply.status(409).send({ error: 'SOLD_OUT' });
      }

      return reply.status(202).send({
        orderId,
        status: 'PENDING',
        statusUrl: `/orders/${orderId}`,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  }
);

app.get('/orders/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const orderData = await redis.hgetall(`order:${id}`);
    if (!orderData || Object.keys(orderData).length === 0) {
      return reply.status(404).send({ error: 'ORDER_NOT_FOUND' });
    }
    return reply.status(200).send({
      orderId: orderData.order_id,
      userId: orderData.user_id,
      productId: orderData.product_id,
      status: orderData.status,
      reason: orderData.reason || null,
    });
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
  }
});

app.get('/health', async () => {
  const pong = await redis.ping();
  return { status: 'UP', redis: pong };
});

app.post('/naive-checkout', async (request, reply) => {
  const userId = (request.headers['x-user-id'] as string) || uuidv4();
  const idemKey = (request.headers['idempotency-key'] as string) || uuidv4();
  const productId = 'phone-1';

  const client = await pgPool.connect();
  try {
    const stockRes = await client.query(
      'SELECT stock FROM inventory WHERE product_id = $1',
      [productId]
    );

    if (stockRes.rows.length === 0) {
      return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' });
    }

    const currentStock = stockRes.rows[0].stock;
    if (currentStock <= 0) {
      return reply.status(409).send({ error: 'SOLD_OUT' });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    await client.query(
      'UPDATE inventory SET stock = stock - 1 WHERE product_id = $1',
      [productId]
    );

    const orderId = uuidv4();
    await client.query(
      'INSERT INTO orders (order_id, user_id, product_id, idem_key, status) VALUES ($1, $2, $3, $4, $5)',
      [orderId, userId, productId, idemKey, 'CONFIRMED']
    );

    return reply.status(200).send({
      message: 'Order placed via naive checkout',
      orderId,
      remainingStockRead: currentStock - 1,
    });
  } catch (err: any) {
    if (err.code === '23505') {
      return reply.status(409).send({ error: 'ALREADY_PURCHASED' });
    }
    if (err.code === '23514') {
      return reply.status(409).send({ error: 'CHECK_CONSTRAINT_TRIGGERED' });
    }
    return reply.status(500).send({ error: err.message });
  } finally {
    client.release();
  }
});

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`API listening on port ${port}`);
  } catch (err) {
    process.exit(1);
  }
};

start();