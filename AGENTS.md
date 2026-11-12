# Inventory Portal contributor instructions

These instructions apply throughout this repository. Read [README.md](README.md)
and [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) before making changes. Consult
[release notes](docs/RELEASE_NOTES.md) and [deployment history](docs/DEPLOYMENTS.md)
when establishing what changed or what is running. Inspect
the code to verify current behavior; planned features are not implemented features.

## Product and architecture

Build a professional electronics and microcontroller inventory system hosted on
the owner's Mac mini and used from Mac and iPhone on a trusted home network.
Keep the application lightweight: FastAPI, SQLite, vanilla JavaScript, Docker
Compose, and persistent local storage. Prefer small additions to this architecture
over new services or frameworks.

Current entry points are `app.py` (API, validation, database access, uploads, AI),
`static/index.html` and its `static/*.js`/`styles.css` assets (vanilla client), and
`docker-compose.yml` (runtime). Inventory, review snapshots and pair decisions live
in `data/inventory.db`; photographs live in `data/uploads/`. Logs and optional
manual reports remain private under `data/`. Selected-component AI reviews send
metadata only and require explicit human approval before pair decisions are applied.
They do not edit component metadata or merge stock.

## Data and operational safeguards

- Preserve all existing inventory records and photographs. Use data-preserving
  migrations for schema changes; never recreate the database as a shortcut.
- Never reset the database or deploy changes without the owner's explicit
  approval. Starting, restarting, rebuilding, or recreating the running deployment
  to apply changes counts as deployment. Preparing code and isolated tests does not.
- Do not delete or overwrite uploads, including photographs retained after a
  component is deleted. Any cleanup needs explicit authorization.
- Never commit secrets, `.env`, SQLite databases or journals, uploads, inventory
  backups, or other private inventory artifacts. Keep `.env.example` free of secrets
  and inspect the diff and staged file list before committing.
- Tests must use temporary databases and upload directories, never the owner's
  `data/`. Importing `app.py` currently creates directories and initializes the
  configured database, so isolate storage before importing it in future tests.
- Mock Claude and OpenAI in automated tests; do not send private photos or incur API charges
  as part of routine verification.

## Development workflow

- Work on feature branches, with small reviewable commits and focused changes.
- Add or update automated tests for behavior changes and run relevant checks.
  API/SSE, JavaScript and Chromium/WebKit suites exist, with mocked AI, static
  browser fixtures and isolated storage.
  GitHub Actions runs Python and JavaScript checks for pull requests and main.
  See README.md for isolated Python and JavaScript test commands.
  Do not report unrun checks as passing.
- Keep documentation aligned with delivered behavior and distinguish plans from
  implementation. Report what changed, verification performed, and remaining gaps.
- Preserve trusted home-network access. The app currently has no authentication;
  document that limitation and do not expose it to the public internet. Changes to
  deployment or network configuration require approval before being applied.
- AI suggestions require human review. Keep ordinary photo storage local and make
  sending photos to Claude/OpenAI an explicit user action with provider routing
  disclosed before submission.

## Development priorities

Follow this order unless the owner directs otherwise:

1. Reliable SSE synchronization between Mac and iPhone, with browser-focus and
   visibility refresh fallback.
2. Automated API regression tests.
3. iPhone camera capture and AI-assisted component identification.
4. QR generation, scanning, and inventory updates.
5. Storage-bin management and project bill of materials (BOM) tracking.
6. Backup and restore.

Use the planned acceptance criteria in the project specification to scope each
feature. Introduce regression coverage alongside SSE work even though building
out the broader API suite is the second priority.

## Build and documentation workflow

- `static/release-notes.json` is the single packaged source for the running build
  number, build API, portal release history and generated `docs/RELEASE_NOTES.md`.
  Build 1 starts explicit numbering; earlier releases are identified by application
  commit, not invented historical numbers.
- Prepend the next integer for each new application release and retain prior entries.
  Documentation-only commits and rebuilding identical source keep the number.
  Never use the host Git checkout, environment or database to guess the runtime build.
- Run `python3 scripts/render_release_notes.py` after manifest edits and verify
  `python3 scripts/render_release_notes.py --check`. Do not hand-edit generated notes.
- Keep README/specification focused on current contracts and explicit plans. Record
  verified deployment evidence and recovery references in `docs/DEPLOYMENTS.md`.
  Source release notes are not proof of deployment. Do not mark prepared builds as
  running before approval and actual runtime verification.
- Keep the build/footer accessible on phone and desktop; build lookup failures must
  not prevent inventory from loading. Do not expose secrets, paths or inventory in
  public build metadata. No Docker change is needed to package files already in static.
