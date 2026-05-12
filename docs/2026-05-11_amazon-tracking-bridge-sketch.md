# Amazon Tracking Bridge Sketch

## Goal

Improve the Amazon package flow for emails that do not contain a carrier tracking
number, but do contain a "Track package" link that eventually reveals an Amazon
Logistics tracking ID (`TBA...`) inside the Amazon app/site.

This is explicitly a staged convenience feature, not a full Amazon automation
system.

## Current State

- Amazon shipped emails usually provide:
  - Amazon order number
  - item title(s)
  - shipping lifecycle state
  - a "Track package" link
- They often do not provide the underlying Amazon Logistics tracking ID
  directly in the email body.
- The app already:
  - imports Amazon order/shipped/delivered emails
  - groups them by `order_id`
  - creates/updates a gift/package
  - can store `tracking_number`, `tracking_status`, `tracking_status_at`, and
    `tracking_estimated_delivery`
- Shippo is not the right backend for Amazon Logistics `TBA...` tracking.

## Proposed Staged Approach

### Phase 1: Save and expose Amazon tracking link

Add a new nullable field on `gifts`:

- `amazon_tracking_url TEXT NULL`

Flow:

1. During Amazon email parse/import, extract the "Track package" URL when
   present.
2. When the import resolves/creates a gift, persist that URL onto the gift.
3. On package detail, show an `Open Amazon tracking` button when the URL exists.
4. On mobile, user taps the button and Amazon app/browser opens the tracking
   page directly.

Value:

- Faster manual workflow
- No credential/session automation
- Useful even if no later automation is added

### Phase 2: Manual TBA capture

Add a lightweight manual path:

1. User opens Amazon tracking via the saved link.
2. User copies the `TBA...` value from Amazon.
3. User pastes it into the existing tracking field in the app.

Notes:

- This is the smallest viable bridge from Amazon's private tracking UI into the
  app's tracking model.
- Once `TBA...` exists on the gift, the app can treat the package as having a
  known tracking identifier, but not a Shippo-compatible one.

### Phase 3: Amazon-specific refresh path

Add a separate refresh path for gifts whose `tracking_number` matches:

- `^TBA\d{12}$`

Behavior:

1. Detect Amazon tracking IDs in the refresh action.
2. Do not call Shippo for those gifts.
3. Instead, fetch Amazon's public tracking page for the TBA number.
4. Parse status / ETA if available.
5. Write results back into:
   - `tracking_status`
   - `tracking_status_at`
   - `tracking_estimated_delivery`
   - `shipment_events` when meaningful checkpoints are parseable

This reuses the app's existing display model while avoiding the false premise
that Shippo can track Amazon Logistics.

### Phase 4: Optional helper extraction

Possible later enhancement:

1. Use the saved `amazon_tracking_url` as a launch point.
2. A local helper running on the user's machine attempts to extract the `TBA...`
   from the Amazon page after the user opens it in an authenticated context.
3. Helper writes the TBA value back into the app.

This should be treated as optional. It is more brittle than Phase 1-3.

## Recommended Scope Boundary

Recommended first implementation:

1. Add `amazon_tracking_url` to `gifts`
2. Parse/store it from Amazon emails
3. Show `Open Amazon tracking` on package detail
4. Support manual paste of `TBA...` into tracking field
5. Add an Amazon-specific refresh path keyed off `TBA...`

Do not initially build:

- server-side Amazon login
- stored Amazon cookies/session in app DB
- automatic clickthrough from Gmail to Amazon to TBA extraction
- pretending Shippo can track Amazon Logistics

## Technical Notes

### Parsing

The Amazon parser should look for the tracking CTA URL in shipped/delivered
emails. This may be present as a normal anchor URL in the HTML body.

Likely parser output addition:

- `trackingUrl: string | null`

### Persistence

Best home is the `gifts` table, not just `import_rows`, because the URL is
useful after import review has been completed.

### UI

Package detail page should show:

- `Open Amazon tracking` button when `amazon_tracking_url` exists
- existing tracking field remains editable for manual `TBA...` entry

### Tracking backend split

Tracking refresh should branch:

- normal carrier tracking numbers -> Shippo path
- `TBA...` -> Amazon path

That split is cleaner than trying to force Amazon through the existing Shippo
registration flow.

## Open Questions

1. Should `amazon_tracking_url` live only on gifts, or also be kept on
   `import_rows` for audit/debugging?
2. Does the current Amazon email HTML reliably expose the final deep link, or
   only a redirect wrapper URL?
3. Is Amazon's public `track.amazon.com/tracking/<TBA>` endpoint stable enough
   for lightweight polling?
4. Should TBA statuses map into the current status vocabulary exactly, or only
   populate `tracking_status*` as informational metadata?

## Practical First-Step Answer

If the user manually pastes a `TBA...` number into the existing tracking field,
the app should be able to support that as a first step, but not by reusing
Shippo registration directly.

The correct first-step behavior is:

- detect TBA numbers
- bypass Shippo
- fetch Amazon tracking status separately
- store the result in the same existing `tracking_status*` fields used by the UI
