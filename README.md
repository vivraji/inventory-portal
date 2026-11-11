# Inventory Portal

A local-first electronics component inventory for Mac and iPhone. Catalog boards, sensors, displays, tools, and parts; attach photos; track stock and storage; and optionally use Claude, with OpenAI backup, to suggest identification from photos.

## Quick start (Mac)

1. Install **Docker Desktop** for Mac and launch it.
2. Unzip this project and open Terminal in the `inventory-portal` directory.
3. Run `docker compose up --build -d`.
4. Open **http://localhost:8000** on your Mac.

Your inventory and uploaded images persist in `./data/`, even when the container is recreated. Back up this directory regularly. The application starts empty; no sample records are added.

## Optional AI identification

Create a workspace-scoped API key in [Claude Console](https://platform.claude.com/settings/keys)
and enable API billing. Add `ANTHROPIC_API_KEY` to your local `.env`; keep the
existing `OPENAI_API_KEY` as backup. Do not paste keys into chat or commit them.
Claude and OpenAI API usage are billed separately from consumer chat subscriptions.
The sample environment file documents configurable model names. The default primary
is `claude-sonnet-5-5`; the existing OpenAI model setting is unchanged.

Compose passes `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and optionally
`ANTHROPIC_WORKSPACE_ID` into the server container alongside the existing OpenAI
backup settings. Use `ANTHROPIC_WORKSPACE_ID` only if your key is not
workspace-scoped. The local `.env` stays private and is never committed. Changes
to keys or model settings take effect on an approved container recreation.

Identification tries Claude first. If its request fails, times out, or returns
unusable output, the same photos are sent to OpenAI when its key is configured.
Without a Claude key, an existing OpenAI-only setup continues to work. Results
show which provider answered. Low confidence alone does not trigger another paid
request; users review the suggestion. Both providers failing returns a safe error.
Ordinary uploads stay local. Photos are sent to providers only when you explicitly
press **Identify with AI**.

Use the front and back slots for the two photos you want in the catalog. Add
close-ups or other angles under **Additional photos for AI identification**. The
AI receives all selected views together (1–6 photos, at most 10 MB each and 20 MB
total). Extra AI photos stay temporary and are not uploaded to catalog storage
unless you choose **Use as front** or **Use as back**. More images may increase
identification cost. JPEG, PNG and WebP are supported for identification; HEIC
can be stored but must be converted before AI identification.

AI identification is advisory and may be inaccurate. Always verify part markings and electrical specifications against manufacturer documentation before wiring components.

## Access from iPhone

Compose currently publishes port 8000 on all host interfaces (`8000:8000`). For iPhone access on the same trusted Wi-Fi, visit `http://YOUR_MAC_LAN_IP:8000` from the iPhone. **This version has no login**, so only do this on a trusted private network. Do not forward the port to the public internet.

For secure access away from home, use Tailscale on both devices and enable Tailscale Serve to expose the local service privately over HTTPS. Consult current Tailscale documentation for the Serve command for your version. Do not enable Funnel (public access). The Mac must remain on and connected.

## Features

- Responsive dashboard with stock counts and low-stock alerts
- Search by name, model, manufacturer, project, or notes
- Filter by category and storage location
- Add, edit, delete component records
- Keep up to two catalog photos per component (front/back; max 10 MB each)
- Optional AI identification from multiple photos, with uncertainty disclosure
- CSV export
- Persistent SQLite database and local photo storage
- Built-in API docs at `/api/docs`

## Architecture

FastAPI + SQLite + HTML/CSS/JavaScript, packaged in one Docker container. SQLite keeps the first Mac-only version easy to install, back up, and maintain. The API and database access are separated enough to migrate to PostgreSQL and a cloud deployment later.

## Security and limitations

- **No authentication yet.** Keep bound to localhost unless using a trusted private network or properly secured private tunnel.
- No multi-user access, cloud sync, QR printing, BOM comparison, or purchase-order tracking yet.
- Images are stored locally and retained when component records are deleted; clean unused images manually if needed.
- For backups, stop the container (`docker compose stop`) before copying `data/` to avoid an inconsistent SQLite copy, then restart (`docker compose start`).
- The AI API requires a separately provisioned key and network access.

## Real-time synchronization

Component creates, edits, and deletes notify connected browsers through SSE at
`/api/events`. Browsers reconnect automatically and reload inventory on every
connection, including after missed events or a server restart. Focus, visibility,
and network-online events also trigger refreshes. Reads are serialized and bursts
are coalesced; open forms and selected filters are preserved. The page shows
connection status, and failed reads retry after three seconds. Browsers without
EventSource retain the focus/visibility refresh fallback.

Event delivery is in memory and requires one Uvicorn worker, matching the current
Docker command. This is LAN synchronization, not offline editing or cloud sync.
Direct database edits do not emit notifications. Concurrent saves still use the
existing last-write-wins behavior. Real iPhone Safari background/resume verification
remains pending. Phase 1 was deployed on 2026-11-11 after approval; read-only
HTTP and SSE smoke checks passed. No deployment is performed by the tests.

## Development tests

Use Python 3.12+ and Node.js 20+ in a development environment:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.cjs
```

Python tests copy application source and static assets into a temporary directory
and start a separate loopback server on an ephemeral port. Only temporary SQLite
and upload storage is used; the project database, photos, environment files, and
running deployment are untouched. Tests mock Claude and OpenAI and cover CRUD, validation, search and filters, stock statistics,
photo types and size limits, CSV content, AI success/error paths, persistence, and
SSE. JavaScript tests cover connection lifecycle, fallback refresh, request
coalescing, recovery, and preserving filters and unsaved forms. GitHub Actions runs
both suites for pull requests and pushes to `main`, using Python 3.12 and Node 24.
The workflow has read-only repository permissions and uses no secrets or deployment
credentials.

## Phase 1 deployment record

On 2026-11-11, merged commit `18282f5` was built and deployed with owner approval.
A stopped-service backup of the database and photographs was saved locally under
`backups/pre-sse-20261111T100703Z/`; SQLite integrity passed. Database, photograph,
`.env`, Dockerfile, and Compose checksums matched after the update. The former image
is retained as `inventory-portal-inventory:pre-sse-18282f5`. Backups are ignored by Git.

Read-only checks passed for `/`, `/api/stats`, `/api/docs`, `/static/sync.js`, and the
initial `/api/events` SSE message. No test inventory records were written to the
running service. Device verification still requires Mac and iPhone: open both
browsers, change a record, confirm the other refreshes, and repeat after switching
Wi-Fi off/on and backgrounding Safari. Check that unsaved forms remain intact.
Any further deployment or restore still requires explicit owner approval.

## Multi-photo identification and metadata

Multi-photo identification and front/back catalog slots are implemented.
Startup adds an `image_back` column without replacing the database. Existing
`image` references become the front slot; records, IDs, quantities, timestamps, and
photographs are preserved. Older API clients can continue sending a single `file`
for identification, and edits that omit `image_back` retain the existing back photo.
CSV export includes both image references. Clearing a slot or deleting a component
retains the underlying photo file.

The new identification API also accepts repeated multipart `files` fields for up
to six views of the same component. It validates the entire set before calling
OpenAI, and does not store identification-only images. The existing model setting
is unchanged. Multi-image requests follow the
[official OpenAI vision documentation](https://developers.openai.com/api/docs/guides/images-vision?api-mode=chat).
HEIC remains supported for storage, but must be converted for identification and
may not preview in every browser. Physical iPhone verification remains pending.

Claude request formatting follows the [official vision guide](https://platform.claude.com/docs/en/build-with-claude/vision)
and [API authentication requirements](https://platform.claude.com/docs/en/api/overview).
Provider keys are never logged or included in client error messages. The
application records private local response diagnostics as described below.

AI identification automatically prefills the component name, category, manufacturer,
model/part number, and notes when those values are returned. Useful visible markings
and identifying features go in notes. Empty or absent suggestions do not clear
existing values. Stock counts, storage location, project, vendor, price, and datasheet
remain user-controlled. Review the suggestions and press **Save component** to
persist them; identifying alone does not create or update inventory records.

## AI diagnostics

The application records each identification attempt in
`data/logs/ai-identification.jsonl` on the Mac. Entries share the log ID returned
by the API and shown below the identification result. They include provider/model,
photo count, response timing, Claude HTTP status and request ID, provider response
text, selection, and the reason an attempt failed or OpenAI was started. HTTP
errors, timeouts, invalid JSON, and unusable structured responses are distinguished.
Past attempts made before this feature was deployed cannot be reconstructed.

After running **Identify with AI**, follow the log from the project directory:

```sh
tail -f data/logs/ai-identification.jsonl
```

Or show the most recent entries with indentation:

```sh
python3 - <<'PYLOG'
import json
from collections import deque
from pathlib import Path
path = Path('data/logs/ai-identification.jsonl')
if not path.exists():
    raise SystemExit('No diagnostic log yet. Run Identify with AI after deployment.')
with path.open() as stream:
    for line in deque(stream, maxlen=12):
        print(json.dumps(json.loads(line), indent=2, ensure_ascii=False))
PYLOG
```

These logs contain AI-generated descriptions and provider error responses, so treat
them as private inventory data. They are not served over HTTP and are ignored by
Git with the rest of `data/`. Files are created with owner-only read/write access.
Each file rotates at approximately 2 MiB, retaining three older files (about 8 MiB
in total); long response fields are truncated at 64 KiB. API keys, request headers,
photo contents/base64 data, and original filenames are excluded or redacted.
Logging failure must not cause a successful Claude result to fall back to OpenAI.
This change does not make live API calls or deploy itself.

## AI metadata validation and save errors

The application displays field-specific save-validation failures. Both providers
receive the same required JSON fields: name, category, manufacturer, model, notes,
confidence, and uncertainty, with no additional fields requested. The schema is
built from the inventory model. Provider schemas use the portable supported
subset; length limits are described in the request and enforced on the server.
Structured output alone does not establish factual correctness.

| Field | Maximum characters |
| --- | --- |
| Name | 180 |
| Category | 80 |
| Manufacturer / model | 120 each |
| Notes | 5000 |
| Uncertainty | 2000 |

The server validates every usable AI response before prefilling. Unknown metadata
is returned as blank text; confidence must be high, medium, low, or unknown. Stock
counts, locations, projects, vendors, prices, and datasheets are not inferred.
Overlong AI labels are shortened to fit and their complete text is preserved in
notes, with a visible warning. If notes still exceed the limit or the data is
invalid, the response is rejected rather than silently losing information. Claude
validation failures can trigger the OpenAI backup and are recorded in diagnostics.

The form independently validates text lengths and quantities before uploading
photos or saving. Oversized notes remain visible for editing. A server 422 response
shows the field and constraint in a persistent message instead of only “Request
failed (422)”. Failed saves retain the form and selected photo references for retry.
The original rejected request was not recorded, so the exact field behind that
past 422 is not known; oversized AI labels are a reproduced failure path.

Structured output formats follow the official
[Claude](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
and [OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs)
documentation. These fixes were deployed with owner approval on 2026-11-11.

## Validation and diagnostics deployment record

On 2026-11-11, merged commit `e9d2de8` was deployed with owner approval. The
pre-deployment database/photos backup is stored locally at
`backups/pre-ai-validation-20261111T112942Z/`. SQLite integrity passed, and checksums
confirmed that the database, existing photographs/data, `.env`, and Docker files
were unchanged after the update. The previous image is retained as
`inventory-portal-inventory:pre-ai-validation`.

All 30 Python and 18 JavaScript tests passed, as did CI and the new image's isolated
API suite. Read-only checks passed for the live UI, validation script, inventory
API, SSE, private log routing and LAN access. No live AI identification was run
for verification; logs are created on the next identification attempt. Further
deployments and restores still require explicit owner approval.

## Responsive layout checks

The mobile layout keeps the dashboard, forms, file controls, photo previews,
long AI messages, error messages, and toasts inside the available viewport. Layouts
use shrinkable grid/flex tracks and wrapping text instead of hiding horizontal
overflow. The scrolling modal tracks `visualViewport` resize/scroll events so its
bounds follow browser chrome, keyboard and zoom changes. iPhone safe-area insets
are respected; form fields use 16px text and buttons have at least 44px height.
Browser zoom remains enabled. Background scrolling is locked while a form is open.
Styles are in `static/styles.css`; no frontend build step or runtime package is added.

Optional browser regression tests use development-only Playwright with static
fixtures, mocked API responses and no live inventory, keys or AI requests:

```sh
npm ci
npx playwright install chromium webkit
npm run test:layout
```

On Linux, use `npx playwright install --with-deps chromium webkit` to install the
browsers and OS libraries, as CI does. Checks cover both engines at nine viewport
sizes from 320px phones to desktop, open-form rotation, long metadata/status text,
photo controls, reachable Save/Cancel actions, and simulated keyboard/zoom viewport
changes. These engine tests do not replace a physical iPhone Safari check.

New records and forms default to a low-stock threshold of 1; existing thresholds,
including 0, are preserved. These changes were deployed with owner approval on
2026-11-11. Further deployments still require explicit approval.

## Mobile layout deployment record

Merged commit `8252d2f` was deployed with owner approval on 2026-11-11. A consistent
local backup is retained at `backups/pre-mobile-layout-20261111T185359Z/`; the previous
image is tagged `inventory-portal-inventory:pre-mobile-layout`. Database/data/photo,
`.env`, and Docker-file checksums matched after deployment. All 53 tests and CI
passed before deployment. Built-image checks and live read-only checks confirmed
the responsive assets, form/API default of 1, inventory, SSE, and home-network
access. Physical iPhone Safari verification remains a user device check.

## Inventory numbers, similarity warnings and comparison (deployed)

The portal provides permanent, server-assigned inventory
numbers such as `INV-000123`. They appear on cards, edit forms, search results,
comparison views and CSV exports. Existing UUIDs remain unchanged. An additive
SQLite ledger assigns numbers to existing entries in creation order during startup,
then assigns numbers to new entries in their save transaction. Numbers remain
stable after edits/restarts and are never reused after deletion; the ledger is
included in the normal full `data/` backup. This feature is deployed.

When saving, possible matches show their inventory numbers, model, location, stock
and a reason for the warning. Choose **Compare with draft**, **Keep editing**, or
**Save separately anyway**. Comparison preserves the unsaved form and selected
photos. The ordinary save checks matches before uploading new photos; the API also
checks atomically before an unconfirmed insert/update so simultaneous duplicate
requests cannot both save unnoticed. Identity changes on edits are checked while
ordinary stock/location edits do not repeat duplicate warnings. No automatic merge
or quantity change occurs. Changing the draft invalidates the prior confirmation.

Select **Compare** on two catalog cards, then **Compare selected**, to view saved
entries side by side. Different values are highlighted, with stock, storage,
projects, manufacturer, part/model, price, datasheet, notes and front/back photos.
Saved entries update when refreshed by SSE; removing a compared entry closes the
comparison. Inventory-number search is available in the main search box.

Matching is local and advisory: normalized part numbers, fuzzy/reordered names,
electronics synonyms (for example MCU/microcontroller, thermal probe/temperature
sensor, LED/light-emitting diode), and common resistor-value notation. It uses no
paid AI calls, embeddings, new external services or photo matching. It cannot detect
all semantic relationships, and related variants can legitimately be separate parts.
Category alone does not trigger warnings; distinct explicit resistor values are
kept separate. Review the numbered entries before deciding.

API clients can use `POST /api/components/similar` for a read-only check, optionally
with `?exclude_id=UUID`. Unconfirmed similar creates or identity-changing updates
return HTTP 409 with `detail.code=similar_components` and up to five candidate
records. After explicit user confirmation, retry the write with
`?allow_similar=true`. Existing inventory-number labels cannot be assigned by clients.
The additive ledger migration was applied during the approved deployment.

## Category consistency and search (deployed)

Category labels use readable Title Case, for example `Sensor Module`, with one
space between words and consistent spacing around `/` and `&`. Common electronics
acronyms such as USB, LEDs, ICs and I2C retain their usual form. Empty categories
become `Other`. The API normalizes categories on create/update and AI identification;
startup canonicalizes older stored labels without changing other fields or
modification timestamps. Case/spacing variants collapse to one filter label,
including an already-selected old spelling. Distinct descriptive subcategories
are retained rather than merged by meaning.

At the owner's request, stored category labels were cleaned up in a dedicated
transaction after a consistent SQLite backup at
`backups/category-cleanup-20261111T193322Z/inventory.db`. Verification confirmed that
all non-category values, IDs, timestamps and photograph files were unchanged.
No container was restarted for that cleanup. The subsequent approved deployment
also prevents new inconsistent entries.

Search checks all textual/numeric record metadata, including notes/description,
category, manufacturer, model, vendor, storage, project, datasheet and inventory
number. It supports partial matches (`photo` finds `photoresistor`; `Amaz` finds
vendor `Amazon`) and common typos (`phoot`, `phto`, `Amzon`). Multiword queries can
match across fields; selected category/location filters still apply. Short queries
and purely numeric values use exact/partial matching, while words of at least four
characters allow one edit (two for longer words), including adjacent transpositions.
Search runs locally, not through a paid AI service, and does not search photo pixels
or internal upload paths. The browser and API share matching regression fixtures.

## Linked similar items (deployed)

A `🔗 N similar` indicator appears on every card that has related entries. Expand
it for links labeled with the other items' inventory numbers and names, plus a
Compare action. Relationships are bidirectional, including more than five linked
peers, and refresh after identity changes or deletion. Expanded lists stay open
through background refreshes. Each link opens the other entry; links copied or
opened in a new tab use `#component=UUID` to open that record after loading.
The relationship map is cached while identities are unchanged and recalculated
locally when necessary. No catalog data is sent to an AI service for these links.

## Related inventory and search deployment record

Merged commit `649a035` was deployed with owner approval on 2026-11-11. The full
local data backup is `backups/pre-related-search-20261111T194729Z`; the previous
image is retained as `inventory-portal-inventory:pre-related-search`. All 68 tests
and CI passed before deployment. Read-only live checks passed for HTTP, assets,
SSE, unique inventory numbers and metadata/typo searches. SQLite integrity passed;
existing inventory values, photographs, environment and Docker files were preserved.
Further deployments and restores still require explicit owner approval.

## Sensor similarity correction — implemented and deployed

A metadata-only Claude/OpenAI review found no likely duplicates among the currently
flagged sensor pairs. Both providers recommended keeping separate entries; some
OpenAI verdicts described shared circuitry as related but distinct. Similarity
matching now rejects explicitly different sensor functions (for example tilt,
ambient light, magnetic, obstacle detection and optical interruption), even when
they share comparator circuitry. Common support ICs such as LM393 are not treated
as sensor module identifiers. Exact matching module model fields remain stronger
evidence, and same-function/name matches remain available. This is a local heuristic,
not a verified identification or electrical compatibility judgment. No records,
quantities, categories or photographs are rewritten; both portal links and save
warnings use the corrected matcher. Further deployments still require owner approval.

The corrected matcher (`351dc5e`) was deployed with owner approval on 2026-11-11.
All 43 Python and 19 JavaScript tests passed before deployment. Live read-only
checks confirmed that all ten reviewed pairs were excluded from reciprocal links
and save prechecks, and HTTP/SSE/LAN access passed. Database contents, photographs,
private reports, environment and Docker files matched the consistent local backup
at `backups/pre-sensor-matcher-20261111T200500Z`. The previous Docker image is
retained as `inventory-portal-inventory:pre-sensor-matcher`.

## Selected-component AI similarity reviews — feature branch; not deployed

Open **AI similarity review** in the sidebar, or **AI review** at the top of the
phone/desktop portal. Search and select 2–8 components, then choose Claude,
OpenAI, or both. Press **Run AI review** to make paid API calls. Every pair within
the selection is checked, even if the automatic matcher did not link it. Both
providers receive the same inventory numbers, names, categories, manufacturers,
models and notes independently. This workflow is metadata-only: photos, UUIDs,
quantities, storage, projects and purchase details are not sent. It does not
re-identify components from photographs or edit component metadata/categories.

Results show each provider's model, verdict, confidence, reasons, differences and
missing evidence. Provider failures are explicit; no automatic fallback/retry or
inventory mutation occurs. When one provider fails, a successful independent review
can still be used after human review. Incomplete/invalid responses cannot be applied.
Saved reviews can be reopened (latest 20 listed) and downloaded as escaped,
self-contained HTML reports. Reports record the AI findings, which can differ from
subsequent user-approved classifications. They contain private catalog metadata.

For each pair you want to change, choose a classification and check **Apply this
pair**, then press **Apply checked classifications**:

- **Possible duplicate** or **Related but distinct** adds a reciprocal reviewed link
  and a save warning for that existing pair.
- **Different components** suppresses the pair's link and warning.
- **Use automatic matcher** removes the previous pair override.

No records are merged/deleted, and quantities, photographs and component fields
are untouched. Decisions apply only to those two existing UUIDs while the reviewed
name/category/manufacturer/model/notes remain unchanged. Metadata changes expire
an override and require a fresh review before applying it again; ordinary stock or
storage edits retain it. Applying a stale or deleted pair fails atomically, without
partially applying other selected decisions. SSE refreshes links on other devices.
Newly added components still receive ordinary automatic duplicate checks.

Reviews and decisions live in additive SQLite tables, included in full database
backups; deleting a component removes its active pair decisions but retains review
history. All review endpoints have the application's existing trusted-LAN-only,
no-authentication access model. Keep private reports and database files out of Git.
No new dependency or Docker configuration is required. Deployment requires approval.

API routes: `POST/GET /api/similarity-reviews`,
`GET /api/similarity-reviews/{id}`, `POST /api/similarity-reviews/{id}/apply`, and
`GET /api/similarity-reviews/{id}/report`. Create takes `component_ids` and `provider`
(`both`, `claude`, `openai`); apply takes `choices` with `pair_id` and `verdict`.
Apply does not call either provider. Provider calls are mocked in automated tests.

On Mac/iPhone on the same home network, the current Mac local hostname allows
`http://mahdi.local:8000` instead of an IP address; network Bonjour/mDNS resolution
must be available. No network settings are changed by this feature.

## Card control alignment — feature branch; not deployed

Cards stretch to the tallest content within each grid row. Stock quantity/status
and Compare controls stay aligned at the bottom, while long names, category labels
and expanded similarity links remain fully readable above them. The layout still
adapts to phone widths without horizontal scrolling. Chromium and WebKit fixtures
verify aligned controls with varying text lengths and expanded links.
