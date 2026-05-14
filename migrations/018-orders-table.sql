-- td-3e9ae2 / td-6c189e: split orders from gifts (1:N).
--
-- Today an Amazon order with N line items destined for N different people
-- gets collapsed into ONE gift row keyed by gifts.order_id. The order's
-- tracking number, ship date, and total live on that single gift, and the
-- review UI offers no way to assign multiple recipients.
--
-- This migration introduces an `orders` table that owns the order-level
-- facts (order_id, tracking, carrier, ship/delivered timestamps, total,
-- Amazon URL) so that one order can fan out to N gifts — each carrying
-- its own person_id and line-item price.
--
-- Strategy:
--  1) Create `orders`. Tracking + lifecycle fields are duplicated on it for
--     the new code path; old code keeps reading the equivalent fields on
--     `gifts` until a later migration drops them.
--  2) Add `gifts.order_pk` (FK to orders) and `gifts.line_item_index`.
--     Both nullable — non-Amazon gifts (manually entered, gift cards from
--     a website without an order#) never get an order row.
--  3) Add `import_rows.parsed_items_json`. Multi-item Amazon emails will
--     populate this with the full per-line breakdown so the review UI can
--     present a per-line recipient picker without forcing N separate rows
--     (preserves the UNIQUE(source_message_id) constraint).
--  4) Backfill `orders` from existing `gifts.order_id` values, point each
--     legacy gift at its new parent order, and stamp line_item_index = 0
--     (every existing order has exactly one gift today, by definition of
--     the bug).
--
-- All new columns are nullable, so plain ALTER TABLE suffices for the
-- existing tables — no recreate-table dance needed. Migration runner
-- toggles foreign_keys OFF before BEGIN and runs PRAGMA foreign_key_check
-- after COMMIT (see migrate.ts).

-- ---------------------------------------------------------------------
-- 1) orders table

CREATE TABLE orders (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id                 TEXT NOT NULL UNIQUE,
  vendor_id                INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  shipper_id               INTEGER REFERENCES shippers(id) ON DELETE SET NULL,

  -- Order total (sum of line items including tax/ship if email exposes it).
  -- Per-line-item prices live on the child gifts.price_cents.
  order_total_cents        INTEGER,

  -- Tracking facts, one shipment per real-world order.
  tracking_number          TEXT,
  carrier                  TEXT,
  tracking_provider_id     TEXT,
  tracking_status          TEXT,
  tracking_status_at       TEXT,
  tracking_estimated_delivery TEXT,
  amazon_tracking_url      TEXT,

  -- Lifecycle timestamps mirroring the gift's, but order-scoped.
  ordered_at               TEXT,
  shipped_at               TEXT,
  delivered_at             TEXT,

  -- Audit trail: which email confirmed the order, free-text admin notes.
  source_message_id        TEXT,
  notes                    TEXT,

  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orders_order_id ON orders (order_id);
CREATE INDEX idx_orders_tracking_number ON orders (tracking_number);
CREATE INDEX idx_orders_provider_id ON orders (tracking_provider_id);

-- ---------------------------------------------------------------------
-- 2) gifts: link to parent order + record line-item position.

ALTER TABLE gifts ADD COLUMN order_pk INTEGER REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE gifts ADD COLUMN line_item_index INTEGER;

CREATE INDEX idx_gifts_order_pk ON gifts (order_pk);

-- ---------------------------------------------------------------------
-- 3) import_rows: per-line-item breakdown JSON.
-- Shape: '[{"title":"...","price_cents":5495,"quantity":1}, ...]'
-- NULL = legacy single-item row; consumers fall back to parsed_title
-- and parsed_price_cents. Populated by the new multi-item parser
-- (src/lib/server/amazon-parser.ts).

ALTER TABLE import_rows ADD COLUMN parsed_items_json TEXT;

-- ---------------------------------------------------------------------
-- 4) Backfill orders from existing gifts.order_id.
-- One synthetic orders row per distinct (non-null, non-empty) order_id.
-- Tracking columns coalesce defensively in case two gifts shared an
-- order_id with diverging values (shouldn't happen pre-migration but the
-- MAX() is cheap insurance).

INSERT INTO orders (
  order_id, vendor_id, shipper_id,
  tracking_number, carrier, tracking_provider_id,
  tracking_status, tracking_status_at, tracking_estimated_delivery,
  amazon_tracking_url,
  ordered_at, shipped_at, delivered_at,
  created_at, updated_at
)
SELECT
  g.order_id,
  MAX(g.vendor_id),
  MAX(g.shipper_id),
  MAX(g.tracking_number),
  MAX(g.carrier),
  MAX(g.tracking_provider_id),
  MAX(g.tracking_status),
  MAX(g.tracking_status_at),
  MAX(g.tracking_estimated_delivery),
  MAX(g.amazon_tracking_url),
  MIN(g.ordered_at),
  MIN(g.shipped_at),
  MIN(g.delivered_at),
  MIN(g.created_at),
  CURRENT_TIMESTAMP
FROM gifts g
WHERE g.order_id IS NOT NULL
  AND TRIM(g.order_id) != ''
GROUP BY g.order_id;

-- Point each legacy gift at its new parent order and stamp line_item_index.
UPDATE gifts
   SET order_pk = (
         SELECT o.id FROM orders o WHERE o.order_id = gifts.order_id
       ),
       line_item_index = 0
 WHERE order_id IS NOT NULL
   AND TRIM(order_id) != '';
