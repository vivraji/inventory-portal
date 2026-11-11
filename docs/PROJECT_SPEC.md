# Inventory Portal project specification

## Objective

Provide a professional electronics and microcontroller inventory system hosted on
the owner's Mac mini and accessible from Mac and iPhone on a trusted home network.
Users should be able to photograph and identify components with OpenAI, maintain
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
| AI | Optional server-side OpenAI call configured through environment variables |
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
| Component details | Name, category, manufacturer, model, quantity, minimum quantity, location, project, vendor, price, datasheet URL, notes, and one image reference |
| Search and filters | Name/model/manufacturer/notes/project search; category and location filters, also supported by the list API |
| Dashboard | Component types, total units, and low-stock counts; low stock means quantity at or below a positive threshold |
| Photos | Upload JPEG, PNG, WebP, or HEIC, up to 10 MiB per photo; photos retained after record deletion |
| AI identification | JPEG, PNG, or WebP submitted explicitly to OpenAI; suggested fields, confidence, and uncertainty shown for review before saving |
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

Ordinary photo uploads stay local. AI identification sends the selected photograph
to OpenAI and requires a separately configured API key. Suggestions are advisory;
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

### 3. iPhone camera and AI identification

Provide a clear iPhone camera capture flow alongside photo-library selection.
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
