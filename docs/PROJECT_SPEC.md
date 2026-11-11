# Inventory Portal project specification

## Objective

Provide a professional electronics and microcontroller inventory system hosted on
the owner's Mac mini and accessible from Mac and iPhone on a trusted home network.
Users should be able to photograph and identify components with Claude, with OpenAI as backup, maintain
stock and storage locations, print QR labels for components and bins, scan those
labels with an iPhone, and track components allocated to projects.

This specification separates the inspected baseline from planned development.
Planned requirements below are not claims of current functionality.

## Current architecture

| Area | Implemented baseline |
| --- | --- |
| Backend | FastAPI in `app.py`; Pydantic input validation; direct SQLite queries |
| Frontend | `static/index.html`, with inline CSS and vanilla JavaScript; no frontend build step |
| Persistence | `data/inventory.db` and `data/uploads/`, mounted into the container as `/app/data` |
| Hosting | Python 3.12 Docker image running Uvicorn; one Docker Compose service on port 8000 |
| AI | Claude primary with OpenAI backup; keys and models configured through environment variables |
| API documentation | `/api/docs` |

The backend, models, schema initialization, and database access currently share
one Python file. Schema initialization uses `CREATE TABLE IF NOT EXISTS`; there
is no migration framework. The frontend fetches all components and statistics at
page load, after its own saves/deletes, on SSE invalidations, and when the browser
regains focus or visibility. It filters the component list locally.

## Implemented features and limits

| Capability | Current behavior |
| --- | --- |
| Inventory | Create, edit, delete, and list component records with UUID identifiers and timestamps |
| Component details | Name, category, manufacturer, model, quantity, minimum quantity, location, project, vendor, price, datasheet URL, notes, and front/back image references (maximum two catalog photos) |
| Search and filters | Name/model/manufacturer/notes/project search; category and location filters, also supported by the list API |
| Dashboard | Component types, total units, and low-stock counts; low stock means quantity at or below a positive threshold |
| Photos | Up to two catalog slots, front/back; JPEG, PNG, WebP, or HEIC, up to 10 MiB each; files retained after removal |
| AI identification | 1–6 JPEG/PNG/WebP views are submitted together explicitly to Claude first, with OpenAI backup; at most 20 MiB total; suggestions reviewed before saving |
| Export | CSV download of component records |
| Synchronization | SSE invalidation after committed component changes; reconnect refresh, focus/visibility fallback, serialized reads, and retry on refresh failures |
| Storage and projects | Free-text location and project fields; location menu displays existing location names |
| Mobile UI | Responsive layout and image file picker; dedicated camera capture workflow is not implemented |

Existing API routes are `GET /api/components`, `POST /api/components`,
`PUT /api/components/{ident}`, `DELETE /api/components/{ident}`,
`GET /api/stats`, `GET /api/events`, `POST /api/upload`, `POST /api/identify`, and
`GET /api/export.csv`. The UI is served at `/`, with static assets and uploaded
photos under `/static` and `/uploads`.

SSE synchronization is merged and deployed. Automated API/SSE regression tests
and browser synchronization tests are implemented; Phase 2 adds broader API
coverage and CI. There is no QR generation/scanning,
storage-bin entity, project BOM, quantity allocation model,
or application backup/restore workflow. CSV export is not a complete backup.
The README describes a manual stopped-container backup of `data/`.

## Network access and privacy

The application has **no authentication or user accounts**. Devices that can reach
the service can access inventory, photographs, and mutation endpoints. Operate it
only on the trusted home network or a secured private connection; do not publish
it to the public internet.

The inspected Compose configuration publishes `8000:8000` on all host interfaces,
supporting LAN access subject to host networking and firewall rules. The README documents this LAN binding.
Preserve the intended trusted home-network access; Phase 1 does not change Compose.

Ordinary photo uploads stay local. AI identification sends selected photographs to Claude first
and to OpenAI on failure. Each provider needs its own API key. The UI discloses
this routing before submission and labels the provider used. Suggestions are advisory;
users must verify markings and electrical specifications. HEIC storage exists,
but conversion for AI identification is not implemented.

## Development phases, in priority order

### 1. Reliable synchronization — implemented; device verification pending

The implementation uses server-sent events (SSE) so committed inventory changes on either device
refresh the other device's inventory, statistics, and filters without a manual
reload. SQLite remains the source of truth; events should trigger authoritative
reads rather than become a second inventory store.

Verification covers real HTTP streams and simulated browser lifecycle events.
The approved Phase 1 deployment passed local read-only HTTP/SSE smoke checks on
2026-11-11. Manual Mac/iPhone Safari verification remains pending. Events
are transient invalidations with a 3-second reconnect hint and 15-second comment
heartbeats. Each connection receives an initial invalidation to recover missed
changes; no replay log is needed. Notifications use bounded per-client queues and
are process-local: run one Uvicorn worker, as in the current Docker configuration.
Multiple workers or replicas would require shared event delivery. Direct SQLite
edits outside the API do not publish events. SSE refresh does not resolve
concurrent edit conflicts; existing full-record update semantics remain.

Acceptance criteria:

- Create, update, and delete changes appear on another connected browser promptly.
- Publish notifications only after successful commits; failed writes emit none.
- Handle disconnects, reconnects, server restarts, and iPhone background/resume;
  reconnecting clients refresh current state even if events were missed.
- Refresh on browser focus and return to visible state as a fallback, with bounded
  duplicate requests and clear handling of connection failures.
- Preserve filters and unsaved form input during background refreshes.
- Clean up disconnected clients and verify two-browser behavior, including iPhone
  Safari. Document any single-process event delivery assumption.

### 2. Automated API regression tests — implemented on the Phase 2 branch

Repeatable tests use temporary storage and a mocked AI client. Coverage includes
CRUD, missing records, validation, combined search/filters, stock threshold
boundaries, photo formats/size limits and retention, CSV content, AI success/error
paths, persistence after reinitialization, SSE commit notifications and reconnects,
and browser lifecycle behavior. README.md documents local commands.

The GitHub Actions workflow runs Python 3.12 API/SSE tests and Node 24 browser
synchronization tests for pull requests and pushes to main. It uses pinned official
actions, read-only repository permissions, and no secrets or deployment credentials.
Tests must never read or mutate live inventory or use a real API key.

### 3. iPhone camera and AI identification — partially implemented

Multi-photo identification and front/back catalog slots are implemented. Users select up to six views of the
same component (10 MiB per image, 20 MiB total), while saving at most two catalog
photos. AI-only references are temporary unless assigned to front or back.
The legacy `image` field is retained as front; an additive, repeatable `image_back`
migration preserves existing records and photos. Older edits omitting `image_back`
preserve it. Old single-file identification requests remain supported, and CSV
exports include both slots. Claude uses asynchronous HTTP and OpenAI calls run off the event loop so SSE
remains responsive. Claude is primary; OpenAI is tried only when Claude fails or
returns unusable output, or when only an OpenAI key is configured. Low confidence
alone does not cause a second call. API keys and upstream failure details are not
exposed. Both providers are mocked in tests. Compose passes Anthropic settings into the container. The owner authorized this
configuration change and deployment; further deployments still require approval.
Automated tests cover migration, request validation, multi-image payloads, photo
selection, and upload retries. The migration is applied only during an approved deployment. These changes do not add HEIC conversion or a camera stream.

AI results prefill name, category, manufacturer, model, and notes for review.
Missing or empty suggestions preserve existing values; quantities, locations,
projects, vendor, price, and datasheet are not inferred. Saving remains explicit.

Still planned: provide a clear iPhone camera capture flow alongside photo-library selection.
Preview images, explain supported formats, handle HEIC conversion or give an
actionable fallback, and show upload/AI progress and recoverable errors. Keep AI
submission explicit, present uncertainty, and let users review or edit suggestions
before saving. Verify the workflow on iPhone Safari and Mac. Determine any camera
secure-context requirements and private HTTPS setup before choosing a browser
camera implementation; deployment still requires owner approval.

### 4. QR labels, scanning, and inventory updates

Generate printable QR labels with stable identifiers for components and storage
bins. Scanning on iPhone should open the relevant record or bin; an in-app scanner
should offer permission/error handling and a manual lookup fallback. Resolve
private host addressing and camera access as part of the implementation design.
Do not put secrets or mutation commands in QR payloads. Scanning alone must not
change stock; users explicitly confirm quantity adjustments. Validate quantities,
avoid duplicate adjustments from retries, and synchronize successful changes.

### 5. Storage bins and project BOMs

Introduce storage bins with stable identifiers, names, and component membership,
preserving existing free-text locations during migration. Introduce projects and
BOM lines with required and allocated quantities. Show available stock and
shortages, prevent over-allocation, and define reserve, consume, release, and
return semantics before implementation. Preserve existing project text when
adding structured relationships. Use transactions and protect concurrent edits
from silently losing stock or allocation changes.

### 6. Backup and restore

Provide a documented, consistent backup of SQLite and all photographs, with schema
version information and integrity validation. Exercise restoration into isolated
storage and verify records and image references. Before replacing live data,
require explicit owner approval and preserve a recovery copy. Document downtime,
failure recovery, and a backup schedule. Do not treat CSV as a substitute for a
full backup or commit backup artifacts to Git.

## Engineering and delivery requirements

- Preserve existing inventory and photographs through all changes and migrations.
- Never commit secrets, SQLite files, uploads, or private backups.
- Keep FastAPI, SQLite, vanilla JavaScript, Docker Compose, and local persistent
  storage as the default architecture; justify substantial new dependencies.
- Use feature branches, automated tests, and small reviewable commits.
- Never reset the database or deploy changes without explicit owner approval.
- Keep trusted home-network access available and document the lack of authentication.
- Update this specification as planned capabilities ship, with verification evidence.

Public hosting, cloud sync, and multi-user accounts are outside the current
delivery scope. Exact future schemas, SSE protocol details, label formats, and
allocation semantics remain implementation decisions to document with each feature.

## Local AI diagnostics — implemented and deployed

The application stores bounded JSON-line response diagnostics under
`data/logs/ai-identification.jsonl`, with a shared request/log ID for Claude and
OpenAI attempts. The browser shows the ID and a safe fallback reason; raw provider
responses remain local to the Mac. Capture response text, status, timing, model,
photo count, failure classification, and provider selection. Never log API keys,
request headers, photo bytes/base64, or original upload filenames. Responses can
contain component details and are private inventory data; logs are not served by
an API or static mount. Owner-only files rotate at 2 MiB with three backups;
individual response fields are capped at 64 KiB. Diagnostics failures must not
change provider selection. Automated tests cover fallback order, successful
Claude responses, redaction, file permissions, bounded output, rotation, and I/O
failure. Historical responses from before deployment are unavailable.

## AI metadata contract and save validation — implemented and deployed

Both providers receive the same required structured JSON fields for descriptive
metadata, confidence and uncertainty. The inventory model supplies field limits:
name 180, category 80, manufacturer/model 120 each, notes 5000; uncertainty is
limited to 2000. Portable provider schemas specify structure and describe limits;
the server enforces types, confidence values and lengths using the inventory model.
Unknown descriptive fields become empty strings, and inventory quantities and
organization are excluded. Long AI labels are shortened while preserving their
complete text in notes; if the combined notes exceed the limit, reject the response
and follow the existing fallback/error path. A valid schema does not prove the
component identification is correct; user review remains required.

Client checks prevent invalid text lengths or quantities from reaching uploads or
save requests. A persistent message names fields rejected by server validation,
without displaying the submitted input from the error payload. Unsaved form data
and successfully uploaded photo references remain available for correction and
retry. Tests reproduce oversized AI labels and verify that the normalized metadata
can be saved through the real API.

The owner-approved validation/diagnostics deployment on 2026-11-11 uses merged
commit `e9d2de8`. Automated checks cover 30 Python tests and 18 JavaScript tests;
CI and live read-only UI/API/SSE/LAN checks passed. A consistent local backup and
previous image were retained. Post-deployment checksums matched all existing
inventory data, photographs, environment settings and Docker configuration.

## Low-stock default — implemented and deployed

New component forms and API-created records default to a low-stock threshold of 1.
Existing records retain their thresholds, including an explicit 0 to disable alerts.
Edits omitting the threshold preserve its stored value. This change does not rewrite
existing SQLite defaults or inventory records; the API supplies the new-record value.

## Responsive viewport behavior — implemented and deployed

Keep dashboard and modal content within the visible viewport at phone, tablet and
desktop widths. Grid/flex descendants must shrink; long AI metadata, diagnostic
IDs, error messages, and action labels wrap. File controls and images remain bounded.
Modals scroll vertically and follow the visual viewport height/offset for browser
chrome, keyboard and zoom; safe-area padding and browser zoom are retained. Prevent
background scrolling while forms are open. Text inputs use at least 16px font and
buttons offer at least 44px height on touch screens.

Development-only Playwright tests run Chromium and WebKit against static fixtures
at nine dimensions, including 320px widths, landscape, tablet and desktop, and
rotate open forms. They check root/modal/control overflow, long status and error
text, photo selection, preserved unsaved values, toasts, and simulated keyboard/
zoom viewport changes. CI runs these alongside API and JavaScript regression tests.
The app remains vanilla JavaScript/CSS without a frontend build step. Physical
Safari keyboard behavior still needs device verification.

The responsive UI and new-record threshold default were deployed with owner approval
on 2026-11-11 using merged commit `8252d2f`. All 53 tests and CI passed. A consistent
backup and previous image were retained, protected-file checksums matched after
the update, and live read-only asset/API/SSE/LAN checks passed. Existing thresholds
and inventory records were preserved.

## Inventory numbers and comparison — feature branch, deployment pending

Assign a permanent `INV-000001` style inventory number server-side. Preserve UUIDs,
record values, photographs and timestamps. Use an additive SQLite AUTOINCREMENT
ledger keyed by component UUID, backfill missing ledger entries in creation order,
and never remove ledger entries when components are deleted. The startup migration
must be repeatable without consuming numbers or renumbering records. New numbers
are allocated in the save transaction; rejected saves do not reserve numbers.
Show numbers in cards, the edit form, search, comparison and CSV export.

Warn before saving if another record has the same normalized model/part number or
a locally similar name using electronics vocabulary, fuzzy word similarity and
common resistor-value notation. This is advisory heuristic matching, not general
semantic embedding or AI judgment. Show up to five numbered candidates with the
match reason, model, stock and location. Never merge or alter existing quantities
automatically. Allow comparison with the draft, correction, or explicit confirmation
to save separately. Check before photo upload and again within an immediate SQLite
transaction on unconfirmed writes. Recheck changed drafts; exclude the edited record
and permit ordinary stock/location updates without repeated identity warnings.

Provide responsive side-by-side comparison for two selected saved components and
for a draft against a warning candidate. Show identifying metadata, stock, storage,
projects, vendor, price, datasheet, notes and front/back images; highlight differing
values. Preserve the open form and draft photos. Update saved comparison values
on inventory refresh, and close comparison if an entry is deleted. Tests cover
migration/number stability, search/export, duplicate confirmation, explicit distinct
part values, concurrency, mobile comparison bounds and draft preservation.
