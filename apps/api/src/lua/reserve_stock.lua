-- KEYS:
-- 1: stock_key      (e.g., "stock:phone-1")
-- 2: buyers_key     (e.g., "buyers:phone-1")
-- 3: order_key      (e.g., "order:<order_id>")
-- 4: stream_key     (e.g., "stream:orders")

-- ARGV:
-- 1: user_id
-- 2: product_id
-- 3: order_id
-- 4: idem_key

-- Rule 1: Reject duplicate buyer
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    return -1
end

-- Rule 2: Check stock availability
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
if stock <= 0 then
    return 0
end

-- Rule 3: Atomic decrement
redis.call('DECR', KEYS[1])

-- Rule 4: Mark user as buyer
redis.call('SADD', KEYS[2], ARGV[1])

-- Rule 5: Save initial order record
redis.call('HSET', KEYS[3],
    'order_id', ARGV[3],
    'user_id', ARGV[1],
    'product_id', ARGV[2],
    'idem_key', ARGV[4],
    'status', 'PENDING'
)

-- Rule 6: Publish event to Redis Stream for the worker
redis.call('XADD', KEYS[4], '*',
    'order_id', ARGV[3],
    'user_id', ARGV[1],
    'product_id', ARGV[2],
    'idem_key', ARGV[4]
)

return 1