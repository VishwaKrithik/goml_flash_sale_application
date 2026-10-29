-- Seed product inventory with exactly 500 units for product 'phone-1'
INSERT INTO inventory (product_id, stock)
VALUES ('phone-1', 500)
ON CONFLICT (product_id) DO UPDATE SET stock = 500;

DELETE FROM orders WHERE product_id = 'phone-1';