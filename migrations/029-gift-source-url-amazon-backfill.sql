-- td-2b5c81: backfill gifts.source_url for existing Amazon-imported gifts.
--
-- The Amazon importer historically wrote only amazon_tracking_url (the
-- shipment "Track package" deep-link), leaving source_url NULL. The edit
-- form's "Source URL" field reads source_url, so Amazon gifts showed an empty
-- field while manual/Tracking-importer gifts did not — the inconsistency in
-- the bug report. Going forward the importer stores the canonical order link
-- in source_url (see amazonOrderUrl in jobs/amazon-import.ts); this one-time
-- backfill brings already-imported gifts in line.
--
-- Scope guards:
--   * source_url IS NULL        — never clobber a manually-entered URL.
--   * order_id present          — the link is keyed on the Amazon order id.
--   * vendor named 'Amazon'     — only gifts attributed to the Amazon vendor.
-- Order ids are digits/hyphens (URL-safe), so plain concatenation matches the
-- encodeURIComponent form the importer now writes.

UPDATE gifts
   SET source_url = 'https://www.amazon.com/gp/css/order-details?orderID=' || order_id,
       updated_at = CURRENT_TIMESTAMP
 WHERE source_url IS NULL
   AND order_id IS NOT NULL
   AND TRIM(order_id) <> ''
   AND vendor_id IN (SELECT id FROM vendors WHERE LOWER(name) = 'amazon');
