# Inventory Portal deployment history

This document records verified deployments. [Release notes](RELEASE_NOTES.md)
describe source changes and do not, by themselves, establish what is running.
Dates below are 2026-11-11 in Pacific time unless stated otherwise; backup directory
timestamps are UTC. Keep backup contents, inventory values and secrets out of Git.

## Current and prepared versions

- Latest verified application: `721e296`, merged PR #9, deployed with explicit
  owner approval. Subsequent documentation commit `ac268b9` did not change the image.
- Prepared source: **Build 1**, with visible build identification and release notes.
  It has not been deployed. Existing Docker/environment/network settings are unchanged.
- Before Build 1 there was no displayed application build number. Do not assign
  historical numbers retroactively or confuse a documentation commit with image code.

## Verified application deployments

| Application source | Changes | Consistent local backup | Retained previous image tag |
| --- | --- | --- | --- |
| `721e296` / PR #9 | Selected AI similarity review, saved reports/decisions, aligned card controls | `backups/pre-selected-ai-review-20261112T000443Z` | `inventory-portal-inventory:pre-selected-ai-review` |
| `351dc5e` | Correct different-function sensor matching | `backups/pre-sensor-matcher-20261111T200500Z` | `inventory-portal-inventory:pre-sensor-matcher` |
| `649a035` / PR #8 | Inventory numbers, comparison, category normalization, broad/fuzzy search, reciprocal links | `backups/pre-related-search-20261111T194729Z` | `inventory-portal-inventory:pre-related-search` |
| `8252d2f` / PR #7 | Responsive viewport layout, new-record low-stock default 1 | `backups/pre-mobile-layout-20261111T185359Z` | `inventory-portal-inventory:pre-mobile-layout` |
| `e9d2de8` / PR #5 | Private AI diagnostics, metadata validation, actionable save errors | `backups/pre-ai-validation-20261111T112942Z` | `inventory-portal-inventory:pre-ai-validation` |
| `18282f5` / PR #2 | SSE synchronization and browser-focus fallback | `backups/pre-sse-20261111T100703Z` | `inventory-portal-inventory:pre-sse-18282f5` |

Earlier source entries, including multi-photo/Claude support (`21f0c31`), API/CI
coverage (`c474997`) and the initial portal (`e04aee0`), are recorded in the release
notes. Their presence in source history is not a claim of a separately verified
standalone deployment. Later verified images include their changes.

## Verification evidence

- PR #9: all 81 tests and CI passed. The built image initialized offline in temporary
  storage. Live HTTP, assets, history, inventory/relationships, SSE and hostname
  access passed. Chromium/WebKit verified live card alignment and the phone review
  selector with mutation/AI requests blocked. Data checks preserved IDs/numbers,
  stock, photos, reports, `.env` and Docker files; a normal API name edit saved after
  startup was retained. SQLite integrity/foreign keys passed. No paid AI calls or
  test inventory writes were made during deployment verification.
- Sensor correction: 43 Python and 19 JavaScript tests passed. Read-only live checks
  excluded the ten reviewed pairs from both reciprocal links and save prechecks;
  data/private artifact/configuration preservation and HTTP/SSE/LAN checks passed.
- PR #8: 68 tests and CI passed, plus image/live read-only checks for numbers,
  search, assets, relationships, SSE and LAN access. Existing values/photos/settings
  were preserved through the additive number migration and category normalization.
- PR #7: 53 tests and CI passed. Backup/configuration hashes and live asset/API/SSE/LAN
  checks passed; existing thresholds were preserved.
- PR #5: 48 tests and CI passed, plus the built image's isolated API suite and live
  read-only UI/API/SSE/LAN checks. Data/photo/environment/Docker checksums matched.
- PR #2: approved image and read-only HTTP/SSE checks passed; database, photographs,
  environment and Docker-file checksums matched the consistent backup.

The owner-requested category cleanup was a separate authorized data-only transaction,
backed up at `backups/category-cleanup-20261111T193322Z/inventory.db`. It changed only
category spelling; non-category fields, IDs, timestamps and photos were verified
unchanged. It did not restart Docker. The later PR #8 deployment prevents new casing
variants. Other deployments require their own approval.

## Deployment and recovery safeguards

1. Inspect Git status without overwriting uncommitted changes. Prepare code on a
   feature branch, update the build manifest/release notes and run relevant tests/CI.
2. Obtain explicit owner approval before applying a deployment. Building, starting,
   stopping, restarting or recreating the live deployment to apply changes is part
   of that operational approval; isolated tests are not deployment.
3. Retain the prior image before replacement. After the approved stop, back up the
   entire `data/` directory, verify SQLite integrity, and retain a local manifest of
   photograph/private-artifact and protected-configuration hashes. Do not copy a
   running SQLite file as if it were a consistent backup. Never commit that backup.
4. Build/check the approved source and start it against the existing persistent
   mount. Preserve `.env`, Docker configuration, network access and upload files.
5. Verify `/api/build` and the displayed footer when available, HTTP/SSE/assets,
   logical inventory/number preservation, photos, review tables and protected files.
   Account for legitimate user edits made through the API after startup; never
   overwrite them to force a checksum comparison to pass. Avoid paid AI or live
   test writes in routine smoke checks.
6. Record application source/build, approval, backup/image references and actual
   checks here. Documentation-only follow-ups need no container restart. Keep source
   release notes and deployment status distinct.

For recovery, test the candidate database/photos in isolated storage first. Obtain
explicit approval before restoring or replacing live data and retain a recovery
copy of the then-current data. Previous image tags are references, not a guarantee
that an older image understands every newer schema or review feature. Never reset
SQLite or delete uploads as a recovery shortcut. Automatic rollback, scheduled
backups and an in-app restore flow are not implemented.
