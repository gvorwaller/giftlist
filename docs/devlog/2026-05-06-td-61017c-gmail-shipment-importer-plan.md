# td-61017c — Auto-import non-Amazon shipment emails as self-packages

## Context

Today the giftlist app has two separate signal paths for "things I'm tracking":
- **Amazon emails** flow through Gmail filter rules → `Giftlist/Amazon/Inbox` → `runAmazonScan` cron → `import_rows` → admin review on `/admin/imports/[id]` → `createGift`. End-to-end automation.
- **Self-packages from anywhere else** (Best Buy order, Circupool, eBay, etc.) require fully manual entry: admin opens `/app/gifts/new`, picks the self-person, types a title, pastes a tracking number, picks the shipper, saves, then clicks "Refresh" so Shippo registers it.

td-61017c closes that gap. The user wants the **same Amazon-style flow** for non-Amazon merchants: Gmail filter rules tag inbound shipment confirmations into a new label, the daily scan stages them into the existing `import_runs`/`import_rows` infrastructure, and admin clicks "Accept" once per package to land it on `/app/packages` with Shippo tracking already registered.

The constraint: **no new paid services**. Shippo's $0.01/registration is the only allowed external cost, and admin must gate every registration via review (no auto-accept tier).

After yesterday's td-68804e work, self-package privacy is settled: each self-person carries an `owner_user_id`, and the scanner runs in admin's OAuth'd context so created packages are owned by admin.

## Key files (referenced or modified)

- **Reference (read, do not modify)**:
  - `src/lib/server/jobs/amazon-import.ts` — pattern to clone (scan, commit, cleanup)
  - `src/lib/server/gmail-reader.ts` — `listLabelMessages`, `getFullMessage`, `batchMoveToLabel`, `trashMessagesUnderLabel` (reuse unchanged)
  - `src/lib/server/tracking.ts:109` — `registerWithProvider` is already idempotent (short-circuits when `tracking_provider_id` set)
  - `src/lib/server/amazon-parser.ts:122-137` — proven sender-domain disambiguation for FedEx-shape false positives
  - `migrations/008-import-tables.sql` — current CHECK constraints on `import_runs.source` and `import_rows.email_type`
  - `src/lib/server/scheduler.ts:35` — `getAdminUserId()` helper, env-tunable cron pattern

- **Net new**:
  - `migrations/014-tracking-import.sql`
  - `src/lib/server/shipment-parser.ts`
  - `src/lib/server/shipment-parser.test.ts`
  - `src/lib/server/jobs/tracking-import.ts`
  - `src/routes/admin/imports/tracking/+page.server.ts` + `+page.svelte`
  - `src/routes/admin/imports/tracking/review/+page.server.ts` + `+page.svelte`

- **Modified**:
  - `src/lib/server/types.ts` — widen `ImportRunSource` and `EmailType` unions
  - `src/lib/server/people.ts` — add `getOrCreateSelfPerson(actorUserId)`
  - `src/lib/server/scheduler.ts` — register two new cron entries
  - `src/routes/admin/imports/+page.svelte` — add "Tracking imports" tile

## Decisions

- **Label**: `Giftlist/Tracking/Inbox` + `/Processed` + `/Failed`. Parallel to `Giftlist/Amazon/*`, untouched.
- **Shippers**: pre-seed DHL (`dhl_express`, verified against existing repo doc at `src/routes/admin/shippers/+page.svelte:36` listing canonical Shippo slugs `usps`, `ups`, `fedex`, `dhl_express`, `ontrac`, `lasership`) in migration 014. **Do not seed Amazon Logistics** in this migration — Shippo has no documented `amazon` carrier slug, and posting an invalid carrier to `/tracks/` would be a hard error. Amazon Logistics shipments arrive via the existing `Giftlist/Amazon/*` flow (handled separately) so the gap is theoretical for the new label. Optionally seed `ontrac` + `lasership` while we're touching the table since `amazon-parser.ts:149` already extracts them.
- **Self-person**: `getOrCreateSelfPerson` finds the existing self-row owned by the actor; **fail loudly** if missing (td-68804e guarantees it exists for admin).
- **Review-first**: every parsed row stages as `disposition='pending'`. No auto-accept tier. Admin clicks Accept → Shippo registration fires.
- **Match priority** (per Plan-agent finding): tracking_number first, then order_id **constrained by sender/vendor**, then create-self. Plain `order_id = ?` is too loose for non-Amazon mail (short merchant-local order numbers collide across vendors); require a normalized sender-domain or vendor match alongside.
- **Cost**: capped at $0.01 × packages-admin-actually-accepts. Estimated < $0.50/yr.

## Implementation phases

### Phase 1 — Schema + types

**Migration `014-tracking-import.sql`** uses SQLite's recreate-table pattern (no `ALTER TABLE DROP CONSTRAINT` in SQLite). **FK choreography matters**: `import_rows.import_run_id` is a live FK to `import_runs` (`migrations/008-import-tables.sql:22`), `foreign_keys = ON` at runtime (`src/lib/server/db.ts:28`), and each migration runs inside one transaction (`src/lib/server/migrate.ts:55`). A naive parent-then-child rebuild can fail mid-transaction. Required steps:

1. `PRAGMA foreign_keys = OFF;` at top of migration (the `migrate.ts` transaction wrapper preserves this for the duration).
2. Rebuild `import_rows` first (drop FK target loosely): `CREATE TABLE import_rows_new (… email_type CHECK (email_type IN ('order_placed','shipped','delivered','marketing','review_request','unknown','tracking_only')) …, parsed_sender_domain TEXT NULL); INSERT INTO import_rows_new SELECT *, NULL AS parsed_sender_domain FROM import_rows; DROP TABLE import_rows; ALTER TABLE import_rows_new RENAME TO import_rows;`. Re-create indexes 008 declared.
3. Rebuild `import_runs` similarly with widened source CHECK. Preserve ids verbatim. Re-create indexes.
4. **New column** on `import_rows`: `parsed_sender_domain TEXT NULL` — required for the order_id match constraint (P0 from Codex review). Backfill from existing `from_address` for Amazon rows is a nice-to-have but skip; old rows aren't accepted into the new path.
5. Insert shipper row: `INSERT INTO shippers (name, tracking_provider_slug, …) VALUES ('DHL', 'dhl_express', …)`. Optionally also seed `('OnTrac','ontrac',…)` and `('Lasership','lasership',…)` since `amazon-parser.ts:149` already extracts those carriers and the slugs are repo-verified. **Do not seed Amazon Logistics** — slug is not in Shippo's published carrier list.
6. `PRAGMA foreign_keys = ON;` at end. Run `PRAGMA foreign_key_check;` and abort on any violation.

Verify post-migration: `sqlite3 data.db 'PRAGMA foreign_key_check;'` returns 0 rows. `SELECT sql FROM sqlite_master WHERE name IN ('import_runs','import_rows');` shows the widened CHECK.

**Types** (`src/lib/server/types.ts`):
- `ImportRunSource = 'amazon_email' | 'tracking_email'`
- `EmailType` adds `'tracking_only'`

Run `npm run check` after the type widen — every switch on `EmailType` must default safely. Confirmed sites that need a glance: `lifecycleStatus` (amazon-import.ts:482), `lifecycleOrder` (line 408), `defaultDisposition` (line 243). All three default safely on unknown variants; no code change needed there.

**`getOrCreateSelfPerson(actorUserId: number)` in `src/lib/server/people.ts`**:
```typescript
const existing = db.prepare<[number], Person>(
  'SELECT * FROM people WHERE is_self = 1 AND owner_user_id = ? AND is_archived = 0 ORDER BY id ASC LIMIT 1'
).get(actorUserId);
if (existing) return existing;
throw new Error(`No self-person found for user ${actorUserId}; create one via /admin/people/new before running the tracking importer.`);
```

### Phase 2 — Parser

**`src/lib/server/shipment-parser.ts`**: export `parseShipmentEmail(msg: GmailMessageFull): ParsedShipment`.

Carrier-regex catalog with sender-domain gating (mirror amazon-parser.ts:122-137 pattern). **Tightened per Codex review** — USPS forms narrowed to published official patterns; OnTrac/Lasership/Canada Post added (they're in `amazon-parser.ts:149` and Shippo's carrier list).

| Carrier | Regex | Scope |
|---|---|---|
| UPS | `\b1Z[A-Z0-9]{16}\b` | distinctive — match anywhere |
| USPS Domestic 22-digit | `\b(?:9[1-5])\d{20}\b` | distinctive — covers 91/92/93/94/95 prefixes (the published official forms) |
| USPS GXG | `\b82\d{8}\b` | distinctive |
| USPS Intl S10 | `\b[A-Z]{2}\d{9}US\b` | distinctive — restricted to `EA`/`EC`/`CP`/`LK`/`RA`/`RR` etc, but `[A-Z]{2}` is acceptable since `…US` suffix is the discriminator |
| Amazon Logistics | `\bTBA\d{12}\b` | distinctive — but routed via Amazon flow, parser still detects for cross-import dedupe |
| OnTrac | `\bC\d{14}\b` | distinctive (rare prefix collision) |
| Lasership | `\bL[A-Z0-9]{10,15}\b` | gated to `*@lasership.com` sender OR `lasership.com` URL |
| Canada Post | `\b\d{16}\b` | gated to `*@canadapost.ca` sender OR `canadapost.ca/track` URL |
| FedEx 12-digit | `\b\d{12}\b` | gated to `*@fedex.com` sender OR `fedex.com/fedextrack` URL in body |
| FedEx 15-digit | `\b\d{15}\b` | same gate |
| DHL | `\b\d{10}\b` | gated to `*@dhl.com` sender OR `dhl.com/track` URL |

Out of scope (deferred): UPS Mail Innovations, FedEx SmartPost, GLS US, LSO, GSO, Veho, Jitsu, PCF — admin can manually create the gift if needed; review queue surfaces the Failed-quarantine row.

Output `ParsedShipment`:
```typescript
{ emailType: 'tracking_only'; trackingNumber: string | null; carrier: 'UPS'|'USPS'|'FedEx'|'DHL'|'Amazon'|null; carrierSlug: string | null; orderId: string | null; merchant: string | null; title: string | null; confidence: 'high'|'low'; }
```

**`src/lib/server/shipment-parser.test.ts`** — Vitest fixtures:
- UPS shipment confirmation (`pkginfo@ups.com` + body `1Z…`) → high, UPS
- USPS 22-digit domestic (94…) → high, USPS
- USPS Intl S10 (`EA123456789US`, `CP987654321US`) → high, USPS
- FedEx 12-digit from `tracking@fedex.com` → high, FedEx
- FedEx 15-digit from `tracking-updates@fedex.com` → high, FedEx
- DHL from `noreply@dhl.com` → high, DHL
- OnTrac (`C12345678901234`) → high, OnTrac
- Lasership from `tracking@lasership.com` → high, Lasership
- Canada Post from `noreply@canadapost.ca` → high, Canada Post
- Merchant promo email with 12-digit "Order #123456789012" from `marketing@somerandom.com` → trackingNumber `null` (FedEx 12-digit gate fails; sender not carrier domain)
- Amazon Logistics TBA → high, Amazon (parser detects for cross-import dedupe even though Amazon-routed)
- Phishing-shaped email (no carrier domain, no carrier URL, but raw `1Z…` in body) → high (UPS regex distinctive enough), trackingNumber populated. Admin review is the safety net.
- Multi-tracking email (two UPS numbers) → returns the first; flag confidence='low' so admin can split manually.
- **Mixed numbers email** (carrier shipment with both an order# `Order: 12345` and a tracking# `1Z…`) → trackingNumber resolves to UPS, orderId resolves to `12345` cleanly without conflation.
- **Empty / no-tracking email** (e.g., a shipping policy update) → trackingNumber `null`, scanner quarantines to FAILED.

### Phase 3 — Job / scanner

**`src/lib/server/jobs/tracking-import.ts`**: clone the amazon-import.ts shell.

```typescript
export const INBOX_LABEL = 'Giftlist/Tracking/Inbox';
export const PROCESSED_LABEL = 'Giftlist/Tracking/Processed';
export const FAILED_LABEL = 'Giftlist/Tracking/Failed';
export const SCAN_JOB = 'tracking_email.scan';
export const CLEANUP_JOB = 'tracking_email.cleanup_processed';
export const PROCESSED_RETENTION_DAYS = 180;
```

`runTrackingImportScan(userId, opts?)`:
- `createRun` with `source='tracking_email'`
- `listLabelMessages(userId, INBOX_LABEL, { maxResults: opts?.limit ?? 50 })`
- Skip already-staged via `source_message_id` UNIQUE check
- Bounded parallelism (concurrency 10, same as Amazon)
- For each message: `parseShipmentEmail` → insert `import_rows` with `email_type='tracking_only'`, `disposition='pending'`
- **Quarantine path**: when `parse.trackingNumber === null`, set `disposition='failed'` + `error_message='no tracking number detected'`, push id into `idsToFailed`
- **Stragglers logic — disposition-aware** (P1 fix per Codex review): copy the *spirit* of amazon-import.ts:194-204 but **route by disposition**, since the tracking flow has both a Failed and a Processed label. Amazon's verbatim logic moves all stragglers to PROCESSED; that would mis-route prior `failed` rows. Required:
  ```
  for each summary in already-staged:
    row = SELECT disposition FROM import_rows WHERE source_message_id = ?
    if row.disposition == 'failed': idsToFailed.push(id)
    else if row.disposition != 'pending': idsToProcessed.push(id)  // skipped or accepted
    // pending stays put — it's awaiting review
  ```
- End of scan: `batchMoveToLabel(idsToFailed, INBOX_LABEL, FAILED_LABEL)` and `batchMoveToLabel(idsToProcessed, INBOX_LABEL, PROCESSED_LABEL)`
- `setRunStatus('ready_for_review')`
- `logAudit({ entityType:'import', action:'tracking_scan', summary: … })`

`runTrackingProcessedCleanup(userId, opts?)`: clone `runProcessedCleanup` from amazon-import.ts swapping the label name.

### Phase 4 — Commit logic

`commitTrackingReviewedRows(userId, decisions)` in the same file. Process accepted rows **sequentially** (not in parallel) so within-batch duplicate tracking# detection works:

```
for each accepted row:
  // 1. Match by tracking_number across all gifts (cross-import dedupe)
  hit = gifts WHERE tracking_number = ? AND is_archived = 0
  if hit:
    mark accepted, link gift_id, no Shippo call, push to messagesToMove

  // 2. Match by order_id + sender/vendor agreement (P0 fix per Codex review).
  //    Plain order_id match is too loose for non-Amazon mail since merchants
  //    reuse short numeric order numbers. Require either a vendor link or a
  //    sender-domain match against the gift's vendor/source_url to bind.
  else if row.parsed_order_id AND row.parsed_sender_domain:
    hit = gifts g
          LEFT JOIN vendors v ON g.vendor_id = v.id
          WHERE g.order_id = ? AND g.is_archived = 0
            AND (
              v.name ILIKE ? -- normalized sender_domain → vendor name
              OR g.source_url LIKE '%' || ? || '%' -- sender_domain in source_url
            )
          ORDER BY id DESC LIMIT 1
    if hit:
      patch tracking_number / carrier / shipper_id onto null fields only
      if hit.tracking_provider_id is set AND hit.tracking_number != row.parsed_tracking_number:
        // mismatch — surface in error_message, do NOT auto-register
        mark failed with "tracking# mismatch on existing gift; reconcile manually"
      else:
        await registerWithProvider(hit.id, userId)  // see concurrency guard below
        mark accepted

  // 3. Create self-package
  else:
    selfPerson = getOrCreateSelfPerson(userId)  // throws if missing
    shipper = getShipperByName(parse.carrier)   // returns row for 'UPS'/'USPS'/'FedEx'/'DHL'/'Amazon Logistics'
    gift = createGift({
      person_id: selfPerson.id,
      title: row.subject ?? row.parsed_merchant ?? '(imported package)',
      vendor_id: null,                          // unknown for non-Amazon merchants
      occasion_id: null,
      occasion_year: new Date().getFullYear(),
      order_id: row.parsed_order_id,
      tracking_number: row.parsed_tracking_number,
      carrier: row.parsed_carrier,
      shipper_id: shipper?.id ?? null,
      price_cents: null,                         // rarely present in carrier emails
      status: 'ordered',
      is_idea: false
    }, userId)
    await registerWithProvider(gift.id, userId)
    mark accepted, link gift_id
```

Skip path: `disposition='skipped'`, no Shippo call, `messagesToMove.push(row.source_message_id)`.

End of commit: single `batchMoveToLabel(messagesToMove, INBOX_LABEL, PROCESSED_LABEL)`. Audit log: `logAudit({ action:'tracking_commit', … })`.

**Concurrency guard for `registerWithProvider`** (P1 fix per Codex review): the existing `registerWithProvider` at `tracking.ts:115-139` reads the gift, returns early if `tracking_provider_id` is set, otherwise POSTs `/tracks/` and writes the result. Two concurrent paths (e.g., admin clicks Accept while a manual `/app/gifts/[id]` Refresh is in flight) can both pass the early-return check and both POST. Shippo bills per registration AND can produce duplicate webhooks. `runJob()` (`src/lib/server/jobs/runner.ts:17`) prevents two scans of the same job name from racing, but it doesn't cover the commit path or the manual refresh path.

Mitigation (cheapest viable): inside `commitTrackingReviewedRows`, before each `await registerWithProvider(...)`, re-read the gift inside a `BEGIN IMMEDIATE` transaction and write a sentinel `tracking_provider_id = 'pending:<row_id>'` if it's still null. Release the transaction, then call Shippo (which itself does the real write). Two callers see the sentinel and both early-return; only one POSTs. If the Shippo call fails, clear the sentinel in a `finally` so a retry can claim it. Out of scope to refactor `tracking.ts` — wrap the call in a guard helper local to `tracking-import.ts` or add a `claimRegistration(giftId)` helper to `tracking.ts` if the manual-refresh path also benefits.

### Phase 5 — Admin UI + cron

**`/admin/imports/tracking/+page.server.ts`** + `+page.svelte`: clone of `/admin/imports/amazon` pages. Need new helpers `getLatestTrackingRun()` / `listRecentTrackingRuns()` exported from `tracking-import.ts` (parameterize the existing helpers in amazon-import.ts on `source` if you want to factor; otherwise duplicate). The existing `getRun()` and `listRowsForRun()` helpers are source-agnostic — reuse them by import.

**`/admin/imports/tracking/review/+page.server.ts`** + `+page.svelte`: clone of amazon review page. UX changes:
- Drop the gift-message column (carriers don't carry it)
- Add a "carrier" column
- Show "→ existing gift #N" or "→ new self-package" inference next to each row
- Color "low" confidence rows amber

**`/admin/imports/+page.svelte`**: add a "Tracking imports" tile next to the existing Amazon tile. Same load shape (latestRun, pendingCount, recentRuns) — wired through the new helpers above.

**Source-aware fan-out** (P1 fix per Codex review): several existing call sites hardcode the Amazon source/route and need to become source-aware:
- `src/lib/server/jobs/reminders.ts:67,79` — reminder emails currently link to `/admin/imports/amazon` review page when staged rows are pending. Branch on `import_runs.source` to route to `/admin/imports/tracking/review/[id]` for tracking runs, or include both as separate digest sections.
- `src/routes/admin/audit/+page.svelte:11,17` — audit listing renders `entity_type='import'` rows with a hardcoded Amazon link. Read the run's `source` and link accordingly. (Audit log itself is source-agnostic; just the rendering.)
- `src/routes/admin/imports/+page.server.ts` (existing landing page) — currently loads only Amazon's latest run. Extend to load both Amazon and Tracking latest-run summaries side by side.

**`src/lib/server/scheduler.ts`**: register two new cron entries using the env-tunable `expr()` pattern. Reuse `getAdminUserId()`:
- `tracking_email.scan` at `35 7 * * *` (between amazon.scan 07:30 and tracking.refresh 07:45). Env: `TRACKING_EMAIL_SCAN_CRON`.
- `tracking_email.cleanup_processed` at `25 3 * * 0` (Sunday 03:25). Env: `TRACKING_EMAIL_CLEANUP_CRON`.

## Risks (in severity order)

1. **`registerWithProvider` defaults to USPS slug when `shipper_id` is null** — closed by pre-seeding DHL (and optionally OnTrac/Lasership) shippers in migration 014 + always passing `shipper_id` from `getShipperByName`. Amazon Logistics deliberately not seeded (no Shippo slug exists per Codex review of Shippo carrier docs).
2. **Migration 014 FK choreography under `foreign_keys=ON`** — `import_rows.import_run_id` references `import_runs.id`; rebuilding either parent or child without the disable/check pattern will fail mid-transaction. Plan now uses `PRAGMA foreign_keys=OFF` at start, rebuilds child first, then parent, then `PRAGMA foreign_key_check` at end. Test the migration on a *copy* of the dev DB before touching the actual dev DB (per cs.md methodology).
3. **Cross-import duplicate tracking# (Amazon + carrier email both arrive)** — closed by tracking_number-first match priority + sequential commit processing.
4. **Concurrent `registerWithProvider` calls** (commit + manual refresh racing) — the existing `tracking.ts:115` early-return is not atomic. Plan adds a transactional sentinel claim before the Shippo POST. Without this, admin double-clicks or coincident manual refresh can double-bill ($0.02) and cause duplicate webhooks.
5. **Order_id collision across vendors** (P0 from Codex) — closed by sender/vendor agreement constraint on the order_id match path; bare `order_id = ?` would mis-bind unrelated gifts that happen to share a short merchant-local order#.
6. **Tracking# mismatch on existing gift** (admin manually edited gift's tracking# after order_id matching staged a new value) — surface as `failed` row with reconcile-manually message; never silently overwrite a registered tracking#.
7. **Stragglers logic disposition-blind** — fixed; previously failed rows would have been swept to PROCESSED label by a verbatim copy of Amazon's logic.
8. **Phishing-shaped emails matching distinctive regexes** (UPS `1Z…`) — admin review is the safety net; the "low confidence" flag is for visual nudging only.
9. **Self-person uniqueness not enforced** — `getOrCreateSelfPerson` does `ORDER BY id ASC LIMIT 1` defensively; if duplicates ever appear, picks the lowest. Out of scope to add a UNIQUE INDEX in this card.
10. **Source-aware fan-out incomplete** — reminders, audit listing, and imports landing all need source-awareness updates. If skipped, tracking runs would either be invisible or mis-link to the Amazon review UI.

## Verification

End-to-end manual smoke test on dev (`npm run dev`, port 5175):
1. Apply migration 014 on a **copy** of the dev DB first. Confirm via `sqlite3 copy.db 'PRAGMA foreign_key_check;'` that 0 violations exist. Confirm widened CHECK via `SELECT sql FROM sqlite_master WHERE name IN ('import_runs','import_rows');`. Confirm `import_rows.parsed_sender_domain` column added. Confirm DHL shipper row inserted (`SELECT * FROM shippers WHERE tracking_provider_slug='dhl_express';`). Then apply on actual dev DB.
2. Create Gmail filter rules manually: from `pkginfo@ups.com`, `tracking@fedex.com`, `auto@usps.com` etc → apply label `Giftlist/Tracking/Inbox`, skip inbox. Tag 2-3 known shipment emails retroactively.
3. Visit `/admin/imports/tracking`, click "Run scan now" → confirm rows staged with parsed tracking#, carrier, confidence, `parsed_sender_domain`.
4. On review page: pick one accept (UPS shipment that has no matching gift) → confirm new self-package on `/app/packages` with `tracking_status='PRE_TRANSIT'` or `'TRANSIT'`. Confirm Shippo registration happened (check `tracking_provider_id` populated). Confirm only ONE Shippo POST in dashboard activity log (concurrency guard working).
5. Pick one skip → confirm row dispositions to `skipped`, email moved to Processed label in Gmail.
6. Force a parse failure (manually drop an unrelated email into the label) → confirm row staged as `failed`, email moved to `Giftlist/Tracking/Failed`.
7. Run scan a second time → confirm idempotent (no duplicate rows; **stragglers self-heal disposition-aware**: previously-failed rows still in inbox land in Failed label, previously-skipped rows land in Processed).
8. **Order_id collision test**: manually create a non-Amazon gift with `order_id='12345'` and `vendor` differing from a staged shipment's sender domain. Accept the staged row → confirm a NEW self-package is created (no false-positive bind), not a patch onto the existing gift.
9. **Concurrency test (informal)**: open two browser tabs to the review page, click Accept on the same row in rapid succession → confirm only one self-package created and only one Shippo POST.
10. `npm run check` clean (0 errors, 0 warnings — CLAUDE.md baseline).
11. Vitest passes: `npm test src/lib/server/shipment-parser.test.ts` (all 14 fixtures green).
12. Manual privacy check: log in as Madonna, verify `/admin/imports/tracking` is gated (admin-only route — already covered by `src/routes/admin/+layout.server.ts:4`) and `/app/packages` shows none of the imported rows.
13. **Audit / reminders fan-out check**: trigger a reminders dry-run with pending tracking rows → confirm digest links resolve to `/admin/imports/tracking/review/[id]`, not amazon. Visit `/admin/audit` → confirm a `tracking_scan` audit row links correctly.

**Migration rollback**: keep a backup of dev `data.db` before applying 014. If `PRAGMA foreign_key_check` fails post-apply, restore from backup. For prod, the deploy script's pre-migration backup (per `scripts/deploy-to-DO.sh`) is the recovery path.

After dev smoke passes: deploy via `./scripts/deploy-to-DO.sh`, set `TRACKING_EMAIL_SCAN_CRON` + `TRACKING_EMAIL_CLEANUP_CRON` env vars on droplet (or rely on the defaults — they're hard-coded sensibly), `pm2 restart`. Verify scheduler boot logs show both new jobs registered.

## Codex review (2026-05-06) — incorporated revisions

Codex flagged 3 P0s, 5 P1s, 2 P2s, and 6 suggested additions. All P0s/P1s and 4 of 6 additions folded into the plan above. Summary of changes:

| # | Codex finding | Pri | Resolution in plan |
|---|---|---|---|
| 1 | Migration FK choreography under `foreign_keys=ON` would fail mid-transaction | P0 | Phase 1 now explicit on `PRAGMA foreign_keys=OFF` → rebuild child first → rebuild parent → `PRAGMA foreign_key_check` |
| 2 | Amazon Logistics slug `amazon` is unverified against Shippo carrier docs | P0 | Decisions section: do not seed Amazon Logistics. Optional seed of OnTrac + Lasership added (repo-verified slugs) |
| 3 | `order_id` match too loose without sender/vendor discriminator | P0 | Match path now requires `parsed_sender_domain` + vendor/source_url agreement; new column added in migration |
| 4 | Stragglers logic not disposition-aware (would mis-route failed → processed) | P1 | Phase 3 stragglers section rewritten to branch on `disposition` |
| 5 | `registerWithProvider` not atomic — concurrent accepts double-bill | P1 | Phase 4 adds transactional sentinel claim helper before Shippo POST |
| 6 | Regex catalog missing OnTrac, Lasership, Canada Post (already in `amazon-parser.ts:149`) | P1 | Catalog extended; tests added for all three |
| 7 | USPS regex too permissive (`\b9[2-5]\d{18,21}\b` matches non-USPS strings) | P1 | Tightened to published official forms (22-digit prefixes 91/92/93/94/95, GXG `82\d{8}`, Intl S10) |
| 8 | `ImportRunSource` fan-out missed: reminders.ts:67, audit/+page.svelte:11 hardcode Amazon | P1 | Phase 5 adds explicit source-aware updates to reminders, audit, and imports landing |
| 9 | `/admin/*` route guard already covers admin-only — no extra check needed | P2 | Verification step 12 cites `src/routes/admin/+layout.server.ts:4` |
| 10 | `runJob()` already prevents same-named scan races, but doesn't cover commit/refresh | P2 | Acknowledged in concurrency-guard rationale (Phase 4); guard applies to commit path |
| + | Add `PRAGMA foreign_key_check` post-migration | add | In Phase 1 + Verification step 1 |
| + | Add vendor/sender-domain normalization on staged rows | add | New `parsed_sender_domain` column in Phase 1; required for order_id match in Phase 4 |
| + | Add parser tests for Lasership, OnTrac, Canada Post, USPS variants, multi-number | add | Test fixtures expanded from 7 to 14 |
| + | Add concurrency guard on Shippo registration | add | Phase 4 sentinel-claim pattern |
| + | Update reminders/audit/imports-home for source-awareness | add | Phase 5 fan-out section |
| + | Verify DHL slug, drop unverified Amazon Logistics | add | Decisions section + Phase 1 step 5 |

Two Codex P2 nits not folded:
- Adding seed shippers for `GLS US`, `LSO`, `GSO`, `Veho`, `Jitsu`, `PCF` — explicitly out of scope; admin can add manually if a real package shows up.
- Codex's mention of UPS Mail Innovations / FedEx SmartPost ambiguity — same rationale; deferred to "Out of scope" line in Phase 2.
