# WORK_STATE

## Execution

- Mode: `state-main`
- Topology: `linear`
- Outcome: Rebuild the console around upstream balances and expandable Key health, add full Key import, real connectivity checks, and PushPlus incident notifications.
- UI reference: `/Users/th/project/中转站相关/上游聚合站6060端口/outputs/my-image/image-20260720T142308417Z-98826-001.png`
- Non-goals: No automatic upstream disabling, route switching, or persistence/exposure of imported full Key secrets.
- Pre-existing user change: `package-lock.json` version updated from `1.6.0` to `1.7.1`; preserve it.

## Delivery Truth

- Local verification: schema migration, import pagination/delta, connectivity status mapping, alert deduplication, API behavior, browser flows, desktop/mobile screenshots.
- Real-environment verification requires a valid PushPlus token, a real Sub2API account, retrievable full Keys, and configured low-cost probe models.
- Without those credentials, delivery is locally and synthetically verified only.

## Tasks

### T-001 Data model and repository

- State: `done`
- Scope: `src/db.js`, `src/repository.js`, focused tests.
- Purpose: Persist import runs, Key presence, connectivity history/current health, alert incidents, and probe settings without losing existing data.
- Pressure check: A passing migration still fails the outcome if old snapshots disappear or imported full Keys leak. Preserve existing rows, never persist imported full Key material, and verify with an upgraded fixture database.
- Acceptance: Existing databases open cleanly; current rows remain; new read/write APIs support later tasks.
- Verification: `node --check` passed; isolated SQLite fixture verified schema creation, Key add/update/group-change reconciliation, and connectivity counters.

### T-002 Full Key import and monitoring API

- State: `done`
- Scope: Key adapter/service, server routes, repository methods, focused tests.
- Pressure check: An import can appear successful while silently truncating pagination or marking unseen pages missing. Fetch until the reported page count/total is exhausted and reconcile only after the complete fetch succeeds.
- Acceptance: All pages import; delta summary reports added/updated/missing/group changes; monitoring payload exposes balance freshness and expandable Key metadata.
- Verification: Four focused tests passed with serial isolated SQLite; pagination, deduplication, reconcile timing, freshness, balance and abnormal-Key aggregation were exercised.

### T-003 Connectivity checks

- State: `done`
- Scope: New connectivity service, scheduler integration, server routes, focused tests.
- Pressure check: A generic health endpoint can pass while model inference fails, while a hard-coded model can create false failures. Use a minimal real inference request only when the upstream has an explicit platform probe model; otherwise return `unconfigured`.
- Acceptance: Single/all-Key checks record latency and normalized states; full Keys remain in memory; concurrency and timeout are bounded.
- Verification: Nine focused tests passed; real inference request shapes, error classification, scheduling interval, result sanitization and multi-Key recording were exercised.

### T-004 PushPlus incidents

- State: `done`
- Scope: Config, notification/alert service, server routes, documentation, focused tests.
- Pressure check: Notification noise or leaked secrets would reduce trust even if delivery works. Open one incident per fingerprint, notify once at threshold, send one recovery, and construct messages only from site name, masked Key and normalized errors.
- Acceptance: Three failures open and notify once; two successes recover and notify once; low balance and sync incidents are deduplicated; no secret appears in payloads.
- Verification: Twelve focused tests passed; PushPlus payloads, Key incident threshold/recovery, zero-balance severity and deduplication were exercised.

### T-005 Frontend rebuild

- State: `done`
- Scope: `public/`, supporting server static setup, package metadata if needed.
- Pressure check: A visually accurate shell still fails if operators must leave it for common actions or if existing modules disappear. Keep the approved monitoring screen pixel-directionally faithful while migrating all current workflows into the same shell.
- Acceptance: UI visually matches the approved reference; balance hierarchy, accordion Key table, filters, import, check, PushPlus status and existing features all remain usable; responsive layouts do not overlap.
- Verification: Browser-tested at 2048x1152, 1440x900 and 390x844. Accordion, navigation, modal and drawer flows worked; no console errors, page overflow, overlapping views or stuck loading overlay were observed.

### T-006 Whole-change verification and docs

- State: `done`
- Scope: Tests, README/deployment docs, final polish.
- Pressure check: Local fixtures can prove contracts and UI but not real PushPlus delivery or real upstream inference. Keep automated tests isolated from user data, run a full server smoke check, and state those real-environment gaps explicitly.
- Acceptance: Automated suite passes; representative browser flows and screenshots pass; remaining real-world gaps are explicit; inspection server is left running.
- Verification: `npm test` passed 15 tests; dry-run module smoke passed; health, monitoring, alerts and local Lucide endpoints responded; browser verified real and fixture databases with no console errors.

## Completion

- State: `complete`
- Server: `http://localhost:4317` using the project database.
- Real-world gaps: PushPlus delivery and real upstream inference remain pending until a valid token, upstream credentials and probe models are configured.
