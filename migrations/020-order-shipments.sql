-- td-d08902: multi-shipment support for multi-recipient Amazon orders.
--
-- Today the `orders` table (migration 018) carries a single tracking_number,
-- carrier, and shipped_at/delivered_at — the comment at orders.tracking_number
-- explicitly says "one shipment per real-world order". That breaks when
-- Amazon ships a 4-item / 3-recipient order in two boxes: the second
-- shipping notification has no place to land, so applyLifecycleEvent ends up
-- either overwriting the first shipment's facts or advancing all siblings
-- including the ones not in this box.
--
-- This migration introduces `order_shipments` (N per order) and a nullable
-- `gifts.shipment_id` so each gift can be attached to the specific shipment
-- that carried it. The order-level summary columns on `orders` stay in place
-- as a denormalized "most recent shipment" cache so legacy reads keep
-- working without an immediate refactor.
--
-- Backfill strategy: every existing order with any tracking facts gets ONE
-- shipment row backfilled from the order's columns; every gift under that
-- order points at it. By definition all pre-migration orders had at most
-- one shipment, so this is lossless.

CREATE TABLE order_shipments (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_pk                    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- Tracking facts for THIS shipment. Multiple shipments per order, each
  -- with its own tracking number.
  tracking_number             TEXT,
  carrier                     TEXT,
  tracking_provider_id        TEXT,
  tracking_status             TEXT,
  tracking_status_at          TEXT,
  tracking_estimated_delivery TEXT,
  amazon_tracking_url         TEXT,

  -- Lifecycle for this specific box.
  shipped_at                  TEXT,
  delivered_at                TEXT,

  -- Audit: which Gmail message confirmed this shipment, plus the per-line
  -- item snapshot from the email body (JSON array of {title, quantity, ...})
  -- so admin can later see what was claimed to be in this box.
  source_message_id           TEXT,
  items_json                  TEXT,

  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_order_shipments_order_pk ON order_shipments (order_pk);
CREATE INDEX idx_order_shipments_tracking ON order_shipments (tracking_number);

-- A gift belongs to at most one shipment per order. NULL = not yet shipped
-- (status='ordered' or earlier) or pre-migration legacy.
ALTER TABLE gifts ADD COLUMN shipment_id INTEGER REFERENCES order_shipments(id) ON DELETE SET NULL;
CREATE INDEX idx_gifts_shipment_id ON gifts (shipment_id);

-- ---------------------------------------------------------------------
-- Backfill: one shipment row per existing order that has any tracking
-- facts. INSERT ... SELECT then UPDATE the gifts to point at the new
-- shipment.

INSERT INTO order_shipments (
  order_pk, tracking_number, carrier, tracking_provider_id,
  tracking_status, tracking_status_at, tracking_estimated_delivery,
  amazon_tracking_url, shipped_at, delivered_at,
  source_message_id, items_json, created_at, updated_at
)
SELECT
  o.id, o.tracking_number, o.carrier, o.tracking_provider_id,
  o.tracking_status, o.tracking_status_at, o.tracking_estimated_delivery,
  o.amazon_tracking_url, o.shipped_at, o.delivered_at,
  o.source_message_id, NULL, o.created_at, CURRENT_TIMESTAMP
FROM orders o
WHERE o.tracking_number IS NOT NULL
   OR o.shipped_at IS NOT NULL
   OR o.delivered_at IS NOT NULL
   OR o.tracking_provider_id IS NOT NULL;

UPDATE gifts
   SET shipment_id = (
         SELECT s.id FROM order_shipments s
          WHERE s.order_pk = gifts.order_pk
          LIMIT 1
       )
 WHERE order_pk IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM order_shipments s WHERE s.order_pk = gifts.order_pk
   );
