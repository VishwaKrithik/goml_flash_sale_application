-- Migration 002: Query optimization indexes
-- Note: UNIQUE(product_id, user_id) and UNIQUE(idem_key) already generate B-tree indexes automatically.

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC);