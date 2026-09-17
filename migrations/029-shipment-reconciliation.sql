-- References are candidates from the email body/links, not item ownership.
ALTER TABLE import_rows ADD COLUMN parsed_order_ids_json TEXT;
CREATE TABLE import_item_resolutions (
  import_row_id INTEGER NOT NULL REFERENCES import_rows(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK(item_index >= 0),
  action TEXT NOT NULL CHECK(action IN ('pending','update','ignore','create')),
  gift_id INTEGER REFERENCES gifts(id) ON DELETE RESTRICT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(import_row_id, item_index)
);
CREATE TABLE import_item_gifts (
  import_row_id INTEGER NOT NULL,
  item_index INTEGER NOT NULL,
  gift_id INTEGER NOT NULL REFERENCES gifts(id) ON DELETE RESTRICT,
  shipment_id INTEGER REFERENCES order_shipments(id) ON DELETE RESTRICT,
  PRIMARY KEY(import_row_id, item_index, gift_id),
  FOREIGN KEY(import_row_id,item_index) REFERENCES import_item_resolutions(import_row_id,item_index) ON DELETE CASCADE
);
