# Inventory Portal

Electronics and microcontroller inventory hosted on a Mac mini and used from Mac
and iPhone. FastAPI, SQLite, vanilla JavaScript/CSS and Docker Compose keep records,
photographs and review history in local persistent storage.

**Access:** [Mac](http://localhost:8000) · [Home network](http://mahdi.local:8000).
The Mac's current local hostname is `Mahdi`. An IP address also works:
`http://YOUR_MAC_LAN_IP:8000`. Devices must be on the trusted home network, and
Bonjour/mDNS must resolve `.local`. Use HTTP with the current deployment.

**No authentication:** anyone who can reach the service can view and modify
inventory and make configured AI requests. Do not publish port 8000 to the internet.
The Mac must remain running and connected. Private HTTPS or remote access is a
separate infrastructure task requiring approval; neither is configured here.

## Documentation and release status

- [Project specification](docs/PROJECT_SPEC.md): architecture, contracts and roadmap.
- [Release notes by build](docs/RELEASE_NOTES.md): feature history from the packaged manifest.
- [Deployment history](docs/DEPLOYMENTS.md): verified deployments and recovery references.
- [Contributor instructions](AGENTS.md): preservation, tests and approval rules.

The latest verified running application is commit `721e296` (PR #9), including
selected-component AI reviews and aligned card controls. **Build 1 is prepared in
this branch and is not deployed yet.** It adds the visible build footer and the
portal's `/release-notes` page. Older builds had no displayed build number.

Build numbers identify application releases, not individual Docker rebuilds or
documentation commits. Once deployed, the footer shows the server's packaged build
on Mac and iPhone; select it to read the release history. `/api/build` and
`/api/releases` return the same packaged metadata without depending on Git being
installed in the container. Inventory reads do not depend on build lookup success.

## Setup and deployment

Docker Desktop must be installed and running on the Mac. From this directory, the
initial setup command is:

```sh
docker compose up --build -d
```

**For an existing deployment, obtain explicit owner approval before building,
starting, stopping, restarting or recreating its containers to apply changes.**
Prepare and test changes on a feature branch first, inspect Git status, retain the
previous image, and take a consistent full backup before replacement. Do not
change Docker configuration, environment settings or network access implicitly.
See [deployment safeguards](docs/DEPLOYMENTS.md#deployment-and-recovery-safeguards).

`./data/` is mounted at `/app/data`; container recreation preserves it. No sample
inventory is inserted. Never delete or reset this directory as a setup shortcut.

## Inventory, search and comparison

- Create, edit and delete component records; keep descriptive metadata, quantities,
  storage, projects, vendor, price and datasheet URL.
- Permanent `INV-000001`-style inventory numbers supplement UUIDs. Numbers survive
  edits/restarts and are not reused after deletion; cards, forms, comparisons,
  search and CSV expose them.
- Search all textual/numeric metadata, including notes/description, category,
  manufacturer, model, vendor, storage, project, dates and inventory numbers.
  Partial terms work: `photo` finds `photoresistor`, `Amaz` finds `Amazon`; common
  typos such as `phoot`, `phto` and `Amzon` are supported. Multiword queries can
  match across fields. Category and location filters still apply. Search does not
  inspect photo pixels or upload paths and does not call AI providers.
- Categories use readable Title Case with spaces (`Sensor Module`), preserving
  acronyms such as USB, LEDs, ICs and I2C. Case/spacing variants share a filter label;
  distinct functional subcategories are retained.
- New records default to quantity 1 and low-stock threshold 1. A positive threshold
  alerts when quantity is at or below it; explicit zero disables the alert.
  Existing thresholds are preserved.
- Select **Compare** on two saved cards, then **Compare selected**. The responsive
  view highlights different fields and includes front/back photographs. Similar-save
  warnings also offer comparison with an unsaved draft.
- Stock/status and Compare controls align across each row of cards despite long
  names, wrapped categories or expanded similar-item lists.
- Export CSV from the menu. CSV contains metadata and image references, not photo
  bytes or complete review/decision history; it is not a full backup.

## Photos and AI identification

Store at most two catalog photographs per component: front and back, up to 10 MiB
each, in JPEG, PNG, WebP or HEIC format. Clearing a slot or deleting a component
retains the underlying files. Photo cleanup requires separate explicit permission.

**Identify with AI** combines 1–6 JPEG/PNG/WebP views of the same component, at most
10 MiB each and 20 MiB total. Add temporary close-ups under **Additional photos for
AI identification**; they are not saved unless chosen as front/back. HEIC can be
stored but must be converted before identification. Dedicated camera capture,
HEIC conversion and physical iPhone camera verification remain planned.

Identification tries Claude first, with OpenAI backup for a missing Claude key,
request failure, timeout or unusable output. Low confidence alone does not trigger
a second call. The UI discloses routing and labels the provider and fallback reason.
Ordinary photo storage stays local; only the explicit Identify action sends photos.

AI prefills name, category, manufacturer, model and notes for review. Empty
suggestions preserve existing form fields. Quantity, storage, project, vendor,
price and datasheet remain user-controlled. Identification alone does not save a
record. Verify physical markings and electrical specifications before use.

Both providers use a structured metadata contract, validated on the server:

| Field | Maximum characters |
| --- | ---: |
| Name | 180 |
| Category | 80 |
| Manufacturer / model | 120 each |
| Notes | 5000 |
| Uncertainty | 2000 |

Unknown descriptive metadata is blank. Confidence is high, medium, low or unknown.
Overlong labels are shortened with full suggestions retained in notes when limits
allow; unusable results are rejected. Save validation names the field and constraint
while keeping unsaved values and photo choices available for correction/retry.

## AI configuration

Copy the names in [.env.example](.env.example) into a private local `.env`, keeping
any existing values. Add a workspace-scoped `ANTHROPIC_API_KEY` and an
`OPENAI_API_KEY` if desired; put keys directly after `=`, without parentheses.
Never paste keys into chat or commit them. API use requires provider billing.

| Setting | Current default / purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude identification and optional independent reviews |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` |
| `ANTHROPIC_WORKSPACE_ID` | Optional workspace routing for a key that needs it |
| `OPENAI_API_KEY` | Identification backup and optional independent reviews |
| `OPENAI_MODEL` | `gpt-4.1-mini` |

Compose already passes these settings. Changes take effect only on an approved
container recreation. Model availability depends on the configured account; provider
errors are shown safely. Automated tests mock both providers and use no real keys.

## Similarity links and AI reclassification

Automatic matching is local and advisory: part/model numbers, normalized names,
electronics synonyms, hardware families and resistor-value notation. It separates
explicitly different sensor functions and does not treat a common support IC such
as LM393 as a sensor module identifier. It is not an electrical compatibility check.

Possible matches warn before ordinary photo upload and again transactionally at
save. Compare, keep editing, or explicitly save separately. No automatic merge or
stock adjustment occurs. Changing a draft invalidates its prior confirmation.
Stock/location-only edits do not repeat identity warnings.

Each detected relationship appears on both cards as **🔗 N similar**, with numbered
links and Compare actions. Expanded lists survive refresh. Copied
`#component=UUID` links open the saved entry; deleted peers disappear on refresh.

To review classifications:

1. Open **AI similarity review** in the sidebar, or **AI review** at the top on phone
   or desktop. Search and select 2–8 components.
2. Choose Claude, OpenAI or both, then press **Run AI review**. This makes paid calls
   for every selected pair, including pairs the automatic matcher did not link.
   Both providers receive the same inventory numbers, names, categories,
   manufacturers, models and notes independently. Photos, UUIDs, stock, storage,
   projects and purchase details are not sent. This is metadata-only review.
3. Compare verdicts, confidence, reasons, differences and missing evidence. Failures
   are explicit; there is no automatic fallback or retry. A successful independent
   provider can still be reviewed if the other fails.
4. Choose a classification and check **Apply this pair** for each intended change,
   then press **Apply checked classifications**. Possible duplicate/related creates
   a reciprocal reviewed link and warning; different suppresses them; automatic
   removes the override. Applying does not call AI or edit component fields.

A decision belongs only to those two existing UUIDs and their reviewed identifying
metadata. Changing name/category/manufacturer/model/notes restores automatic
matching; a stale/deleted pair cannot be applied. Stock/storage edits retain the
decision. Applying multiple checked pairs is atomic and publishes SSE after commit.
New records still receive ordinary duplicate checks.

Saved reviews retain snapshots and provider findings; reopen the latest 20 from
the menu or download their self-contained HTML reports. Reports describe AI
findings, not necessarily applied classifications. Full database backups include
reviews and decisions. One-off local catalog/photo HTML exports under
`data/reports/` are separate private artifacts, not a portal export feature.

## Synchronization and responsive behavior

`/api/events` sends an initial inventory invalidation and notifications after
successful inventory/relationship commits. Browsers reconnect automatically with a
three-second retry hint. Focus, visibility and network return refresh current data;
reads are serialized/coalesced and failures retry. Filters, draft values and photo
choices survive background inventory updates.

Events are transient and process-local: use the single Uvicorn worker in the
current Docker image. Multiple workers/replicas need shared event delivery. Direct
SQLite edits do not publish events; concurrent full-record saves remain last-write-wins.

The UI follows the visual viewport, safe areas, rotation and browser chrome, with
scrollable modals, readable inputs and touch controls. Chromium/WebKit tests cover
phone through desktop widths and simulated keyboard/zoom changes. Physical iPhone
Safari camera and background/resume verification are still outstanding.

## Data protection, diagnostics and backup

- SQLite: `data/inventory.db`; photographs: `data/uploads/`.
- Private AI diagnostics: `data/logs/ai-identification.jsonl`, created on the first
  identification/review attempt that logs an event. They include provider responses,
  request IDs, model, HTTP/timing and fallback details. Keys and image data are
  redacted; files are owner-only, rotate at 2 MiB with three older copies, and are
  not served over HTTP. Events from before logging existed cannot be reconstructed.
- Private manual reports can live under `data/reports/`. Review history and active
  classifications are stored in SQLite, not in those HTML artifacts.
- Never commit `.env`, database files/journals, uploads, reports or backups. Never
  reset the database, overwrite uploads or deploy without approval.
- After approval, stop the container before copying all of `data/` for a consistent
  manual backup; retain the prior image. Restart requires the approved operational
  scope. Verify database integrity, inventory/number preservation and photo hashes.
  Restore first into isolated storage; live restore requires separate approval and
  a recovery copy. No in-app backup/restore or scheduled backup service exists yet.

Follow diagnostics locally after an AI attempt:

```sh
tail -f data/logs/ai-identification.jsonl
```

If the file does not exist, no diagnostic event has been written yet. The portal
identification result shows its log ID. Review history supplies separate review IDs.

## Development and build numbering

Use feature branches and small reviewable commits. Python 3.12+ and Node.js 20+:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.cjs
npm ci
npx playwright install chromium webkit
npm run test:layout
python3 scripts/render_release_notes.py --check
git diff --check
```

On Linux browser setup may need `npx playwright install --with-deps chromium webkit`.
Tests copy application/static source into temporary storage; never import workspace
`app.py` against live data. Providers are mocked. CI uses Python 3.12, Node 24 and
Chromium/WebKit, with read-only repository permissions and no deployment secrets.

[static/release-notes.json](static/release-notes.json) is the single release manifest.
For the next application release, prepend the next integer build, retain prior
entries, summarize changes, and run `python3 scripts/render_release_notes.py`.
Do not invent commit hashes for unreleased code. Documentation-only updates and
rebuilding the same source keep its number. API/UI/tests read the packaged manifest;
never derive the runtime number from the host's current Git branch or `.env`.

## Still planned

Dedicated iPhone camera capture/HEIC conversion, QR generation/scanning and
confirmed stock updates, storage-bin entities, structured projects/BOM allocation,
and an in-app backup/restore workflow. Locations and projects are free text today;
there are no accounts, cloud sync, purchase-order workflows or public hosting.
