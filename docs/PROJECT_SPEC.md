# Inventory Portal project specification

## Objective and delivery status

Maintain a professional electronics/microcontroller inventory on the owner's Mac
mini, usable from Mac and iPhone over the trusted home network. Preserve all
existing inventory, photographs and local configuration throughout development.

The latest verified deployed application is `721e296` (PR #9). It includes the
inventory, synchronization, photos, search, comparison and AI similarity-review
features below. **Build 1 is implemented in the current branch but not deployed:**
it adds build identification, portal release notes and consolidated documentation.
[Release notes](RELEASE_NOTES.md) describe source changes;
[deployment history](DEPLOYMENTS.md) records verified runtime updates.

## Architecture

| Area | Current implementation |
| --- | --- |
| Server | FastAPI in `app.py`; Pydantic validation; direct SQLite transactions; one Uvicorn worker |
| Client | Vanilla JavaScript in `static/index.html`, `sync.js`, `photos.js`, `compare.js`, `search.js`, `reviews.js` and `viewport.js`; styles in `static/styles.css` |
| Data | `data/inventory.db`, local `data/uploads/`, private logs and optional manual reports |
| Hosting | Python 3.12 Docker image; one Compose service; persistent `./data:/app/data`; port `8000:8000` |
| AI | Claude primary/OpenAI backup for photo identification; independent selected providers for metadata pair reviews |
| Build 1 additions | Packaged `static/release-notes.json`, `build.js`, release-notes HTML/JS, `/api/build`, `/api/releases`, `/release-notes` |
| Verification | Isolated Python API/SSE tests, Node tests, Chromium/WebKit fixtures and GitHub Actions |

The application/database logic shares `app.py`; importing it initializes configured
local storage. Tests copy the source/static files into temporary directories before
import. There is no frontend framework or bundler, external database, migration
framework, authentication service or background job infrastructure.

Startup creates tables if missing and applies additive, repeatable changes:
`image_back`, an inventory-number ledger, review history and active pair decisions.
It canonicalizes category spelling without changing other component fields or
modification timestamps. Never replace/recreate the live database to migrate.

## Implemented inventory contracts

- UUID identity plus a permanent `INV-000001`-style number. The AUTOINCREMENT ledger
  backfills existing entries in creation order, allocates numbers in save
  transactions and retains ledger entries after deletion so numbers are not reused.
- CRUD fields: name, category, manufacturer, model, quantity, minimum quantity,
  location, project, vendor, unit price, datasheet URL, notes and front/back references.
  Creation/modification timestamps and UUIDs are preserved through migrations.
- New-record quantity and minimum quantity default to 1. Positive minimums alert
  at or below the threshold; explicit zero disables alerts. Existing minimums and
  omitted threshold/back-photo values on older edit requests are preserved.
- Category labels use Title Case with spaces, normalized spacing around `/` and
  `&`, and common electronics acronyms retained. Case variants collapse in filters;
  distinct descriptive subcategories are not merged by meaning.
- Search covers textual/numeric metadata except image references. It normalizes
  case/diacritics, supports literal partial terms, AND terms across fields and
  bounded adjacent-transposition/insertion/deletion/substitution matching. Words
  4–7 characters allow one edit, longer supported terms two; short/numeric terms
  remain literal/partial. Browser and API use shared regression fixtures.
- Category/storage filters still constrain search. Search never calls AI or reads
  photo pixels. CSV exports metadata, inventory numbers and image references, not
  photo bytes or complete review history.
- Full-record updates remain last-write-wins; there is no optimistic edit locking.
  Projects and storage are free text, not BOM/bin entities.

## Photos and identification

Catalog slots are front (`image`) and back (`image_back`), at most two. Uploads allow
JPEG/PNG/WebP/HEIC up to 10 MiB each. Removing a reference or deleting a record
retains uploaded files. Any cleanup needs explicit permission.

Explicit identification accepts 1–6 JPEG/PNG/WebP views, up to 10 MiB each and
20 MiB total. Validate the whole selection before a provider call. Additional views
are temporary unless explicitly assigned to catalog slots; old single-file API
requests remain supported. HEIC conversion and dedicated camera capture are planned.

Use Claude first, then OpenAI if Claude is unconfigured, fails, times out or returns
unusable output. Low confidence alone does not cause fallback. Disclose routing
before photo submission and show provider, confidence, uncertainty, fallback reason
and diagnostic ID. Ordinary photo storage remains local.

Prefill only name/category/manufacturer/model/notes; preserve existing fields for
empty suggestions. Require user review and an explicit save. Do not infer stock,
storage, projects, vendors, prices or datasheet links. Validate structured output
and lengths: name 180, category 80, manufacturer/model 120 each, notes 5000,
uncertainty 2000. Retain complete overlong labels in notes when possible; reject
unusable results. Field-specific save errors retain drafts and photo choices.

Use configured provider keys/models from `.env` via existing Compose environment
settings. Current defaults are `claude-sonnet-5-5` and `gpt-4.1-mini`; account/model
availability is external. Tests mock both providers and never incur routine charges.

## Similarity, comparison and review

Automatic matching uses normalized models/names, electronics vocabulary, hardware
families, fuzzy wording and resistor notation. Explicitly different sensor functions
are separated; common support ICs such as LM393 do not identify a sensor module.
This heuristic cannot establish compatibility or catch all duplicates.

Unconfirmed similar creates/identity-changing updates return 409 with
`detail.code=similar_components` and up to five numbered candidates. Support a
read-only precheck excluding the edited UUID. Check before photo uploads in the UI
and again transactionally at write. Explicit `allow_similar=true` permits a separate
save; changed drafts require rechecking. Never merge or adjust quantities automatically.
Stock/location-only edits do not repeat identity warnings.

The portal compares two saved entries or a draft/candidate with differing fields
highlighted and front/back photos. Saved comparisons refresh via SSE and close when
a compared entry is deleted. Similarity links are reciprocal, include all peers,
use stable UUID hash URLs, preserve expanded lists through refresh and remove stale
peers. Reviewed classifications label the relationship reason. Heuristic-only
relationship maps are cached while identities are unchanged; active review decisions
are evaluated with current fingerprints.

The AI review menu and phone-visible button select 2–8 components and review every
selected pair. Send only inventory numbers, names, categories, manufacturers,
models and notes to Claude, OpenAI or both independently. Disclose paid calls and
metadata-only scope; do not send photographs, UUIDs, stock, storage or purchase data.
There is no automatic fallback/retry, photographic re-identification or category edit.

Require complete validated pair IDs, verdicts, confidence and bounded explanations.
Show safe provider failures; if one succeeds it can still be reviewed. Store
immutable snapshots/findings in `similarity_reviews`; list the latest 20 and retain
older history. Allow reopening and an escaped self-contained HTML download. Reports
record findings, not necessarily applied decisions.

A separate apply action accepts checked possible-duplicate/related/different/reset
decisions after human review. Positive classifications create reciprocal links and
warnings; negative suppresses them; reset removes the override. Bind decisions to
both UUIDs and fingerprints of name/category/manufacturer/model/notes. Changed
metadata restores automatic matching; stale/deleted pairs cannot be applied. Stock
and storage edits retain decisions. Validate every chosen pair before writing, apply
atomically, then publish SSE. Do not edit components, photos or quantities. New
entries are not covered by another pair's decision. Deletion cascades active decisions
while retaining review history; database backups include both tables.

## Synchronization and responsive UI

Publish inventory invalidations only after committed writes and on each SSE
connection. Reconnect with a three-second hint and send 15-second keepalives; event
history is not persisted. Browser focus/visibility/network return refreshes data,
reads are serialized/coalesced and failures retry. Preserve filters and unsaved
forms/photos. Direct external SQLite edits do not notify clients.

In-memory events require one Uvicorn process. Multiple workers/replicas require
shared delivery. This is LAN synchronization, not offline editing or cloud sync.
Physical Mac/iPhone Safari background/resume verification remains outstanding.

Use safe-area spacing, visible-viewport-aware scrollable modals, readable inputs,
touch targets and bounded content. Cards stretch equally within each grid row;
stock/status and Compare controls align at the bottom, with related links above.
Test long names/categories, expanded lists, phone/landscape/tablet/desktop widths,
rotation and simulated keyboard/zoom in Chromium and WebKit. Actual iPhone camera,
keyboard and background behavior still need device verification.

## Build identification and release history — prepared, not deployed

Build 1 begins explicit integer application build numbering. The packaged release
manifest is the single source for `/api/build`, `/api/releases`, the visible footer,
the portal release page and generated Markdown notes. It is copied by the existing
Docker `COPY static` step; no Docker/environment/network change is needed.

Display the server build on phone and desktop, link to `/release-notes`, and keep
inventory usable if build lookup fails. Earlier source releases are labeled by Git
commit rather than invented retrospective numbers. Build metadata contains no local
paths, secrets, inventory or runtime environment details. Numbers advance with
application releases; documentation-only commits and identical-source rebuilds keep
the number. Track approval/deployment evidence separately from source release notes.

## HTTP interface

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/`, `/static/*`, `/uploads/*` | Portal, packaged assets and local photos |
| GET | `/api/docs` | Interactive FastAPI documentation |
| GET/POST | `/api/components` | Search/list and create |
| PUT/DELETE | `/api/components/{ident}` | Full update or delete; photo files retained |
| POST | `/api/components/similar` | Read-only advisory save precheck |
| GET | `/api/components/relationships`, `/api/stats`, `/api/events` | Symmetric links, statistics, SSE |
| POST | `/api/upload`, `/api/identify` | Catalog upload and explicit photo identification |
| GET | `/api/export.csv` | Metadata CSV |
| GET/POST | `/api/similarity-reviews` | Latest review history and explicit paid review |
| GET | `/api/similarity-reviews/{review_id}` | Saved immutable review |
| POST | `/api/similarity-reviews/{review_id}/apply` | Apply checked user decisions without AI calls |
| GET | `/api/similarity-reviews/{review_id}/report` | Download review findings as HTML |
| GET | `/api/build`, `/api/releases`, `/release-notes` | Build 1 additions; not deployed yet |

There is no `GET /api/components/{ident}` detail route; clients use the list data.
All routes share the existing no-authentication trusted-LAN access model.

## Privacy, preservation and operations

Never commit keys, `.env`, databases/journals, uploads, private reports or backups.
AI response logs in `data/logs/ai-identification.jsonl` are private and created lazily.
Record provider/model/status/timing/response/fallback details with request/review IDs;
redact keys and photo bytes/base64. Use owner-only files, a 2 MiB rotation limit and
three older copies; bound long response fields. Diagnostic failure must not change
a successful identification into fallback. Logs/private manual reports have no HTTP
mount; explicit review/history endpoints return their stored findings.

The app has no authentication/accounts. Compose exposes port 8000 on host interfaces
for trusted LAN access. The current local URL is `http://mahdi.local:8000` if mDNS is
available; localhost and the LAN IP also work. Do not expose it publicly. Private
HTTPS, remote access, network/security changes and container deployment need approval.

Take consistent full-data backups with the container stopped after approval; retain
previous images, verify SQLite integrity/logical records/photo hashes and test
restores in isolated storage. Live restore requires explicit approval and a recovery
copy. Do not reset the database, delete uploads or overwrite uncommitted work.

## Roadmap in priority order

1. **SSE — implemented:** retain regression coverage; complete physical device
   background/reconnect and unsaved-form checks.
2. **Automated regressions — implemented:** isolated API/SSE, JavaScript and real
   browser fixtures plus CI. Mock providers; no live inventory or paid routine tests.
3. **iPhone camera/identification — partial:** multi-photo identification exists;
   dedicated capture, HEIC conversion/fallback, camera errors and device checks remain.
4. **QR — planned:** stable component/bin labels, iPhone scan/open, manual fallback
   and explicitly confirmed quantity adjustments; scanning alone must not mutate stock.
5. **Storage bins and BOMs — planned:** structured bins/projects, membership,
   required/allocated/available quantities and reserve/consume/release/return semantics;
   preserve existing free text and prevent over-allocation transactionally.
6. **Backup/restore — planned:** an in-app full-data workflow and schedule, isolated
   restore verification, schema/version information and approved live recovery.

Keep FastAPI/SQLite/vanilla JS/Docker lightweight. Work on feature branches, add
focused tests, run checks, keep docs/release notes consistent and obtain approval
before deployment or destructive/security/infrastructure changes.
