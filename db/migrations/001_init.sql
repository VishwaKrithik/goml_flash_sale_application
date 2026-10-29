-- Schema migration for flash-sale engine

CREATE TABLE IF NOT EXISTS inventory (
    product_id VARCHAR(64) PRIMARY KEY,
    stock INTEGER NOT NULL,
    CONSTRAINT check_stock_non_negative CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
    order_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    product_id VARCHAR(64) NOT NULL,
    idem_key VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_product_user UNIQUE (product_id, user_id),
    CONSTRAINT unique_idem_key UNIQUE (idem_key)
);