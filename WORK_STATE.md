# WORK_STATE

## Execution

- Mode: `state-main`
- Topology: `linear`
- Outcome: Turn Settings into a safe runtime operations center for automatic sync, paid Key probes, PushPlus delivery rules, per-upstream overrides, retention, and manual alert acknowledgement.
- UI direction: Preserve the approved operations-console layout and visual language; use compact setting tabs, switches, numeric controls, and the existing dense table patterns.
- Non-goals: No browser editing of `APP_SECRET`, database path, port, admin/session secrets, or PushPlus base URL; no automatic model-catalog sync; no automatic upstream switching, Key disabling, or destructive Key actions.
- Git baseline: The worktree contains the completed prior goal built from clean commit `f5a0f76`; all of those uncommitted product changes must be preserved.
- Runtime guardrail: The port 4317 server was stopped before implementation so automatic sync, paid inference probes, and notifications cannot run while settings behavior is incomplete.

## Delivery Truth

- Local verification: additive migration compatibility, typed runtime-setting persistence, scheduler due logic, notification grouping/deduplication, acknowledgement semantics, APIs, and desktop/mobile browser flows.
- Real-environment verification: one explicitly labeled PushPlus test message only. No full-batch inference probe is required for this goal.
- Environment precedence: startup environment flags remain hard emergency disables; database settings are runtime controls only when the corresponding environment scheduler is allowed.
- Completion claim: The work is complete only when settings save without restart, acknowledged incidents remain distinct from recovered incidents, grouped notifications are proven, and prior upstream/Key behavior remains intact.

## Tasks

### T-201 Runtime settings model and APIs

- State: `done`
- Scope: `src/config.js`, `src/repository.js`, a focused runtime-settings service if needed, `src/server.js`, migration/repository/API tests.
- Purpose: Persist validated operational settings with current environment/default behavior as the compatibility fallback.
- Pressure check: A settings API can appear correct while silently enabling schedulers that were hard-disabled in the environment or changing current production defaults. Store only safe runtime fields, preserve absence-as-current-behavior, and expose effective values plus environment locks.
- Acceptance: Typed settings round-trip; invalid ranges are rejected; no boot secret is writable; missing settings reproduce current behavior; scheduler environment disables cannot be bypassed.
- Verification: Focused migration, repository, and route/service tests plus syntax checks.
- Evidence: Runtime/migration/repository tests passed 10/10. Settings use the encrypted `console_settings` store, merge partial updates against current defaults, reject unknown and out-of-range fields, and expose effective values with environment hard-disable locks. Syntax and diff checks passed.

### T-202 Dynamic schedulers and per-upstream policy

- State: `done`
- Scope: scheduler loops, sync/Key due logic, upstream schema/repository/API, focused tests.
- Purpose: Apply saved settings without restart while retaining site-level control over sync, probes, alerts, thresholds, and intervals.
- Pressure check: Shortening an interval could immediately launch a costly full probe, and a static `setInterval` could ignore new settings. Saving must not directly execute work; a bounded dispatcher reads current settings and runs only due sites.
- Acceptance: Runtime toggles and intervals apply on the next dispatcher pass; per-upstream overrides win; environment hard disables win; model sync remains manual.
- Verification: Fake-clock scheduler tests and API persistence tests without external requests.
- Evidence: Focused scheduler/migration/repository tests passed. A 10-second dispatcher reads current settings, prevents overlapping jobs, honors environment hard disables, and passes current concurrency, timeout, retention, and default intervals without executing work on save. Per-upstream sync, probe, notification, and low-balance switches persist independently.

### T-203 Configurable PushPlus rules and grouping

- State: `done`
- Scope: alert service, connectivity batching, repository alert metadata, PushPlus status/rules APIs, focused tests.
- Purpose: Keep per-Key incident history while sending calm, configurable WeChat notifications.
- Pressure check: Grouping alerts by replacing per-Key records would lose diagnosis and make partial recovery ambiguous. Keep records per Key, gather newly due notifications after a site check, then send one grouped message when configured.
- Acceptance: Event toggles affect delivery only; IP blocks can be muted; default delivery groups by upstream; thresholds, recovery, reminder interval, quiet hours, and notification master switch are honored; failures remain recorded.
- Verification: Stateful fake-repository/fake-notifier tests for grouping, deduplication, reminders, quiet hours, and recovery.
- Evidence: Alert/connectivity/runtime tests passed 22/22. Separate per-Key records produced one upstream-grouped delivery, muted IP blocks remained recorded, reminder eligibility respected elapsed time, quiet hours were testable, and the existing incident/recovery path remained compatible.

### T-204 Alert acknowledgement

- State: `done`
- Scope: alert migration/repository/API, alert service suppression rules, focused tests.
- Purpose: Let operators mark incidents handled without pretending the upstream recovered.
- Pressure check: Reusing `resolved` would create a new incident on the next failed check. Add acknowledgement metadata while leaving the incident open until a real recovery.
- Acceptance: Single and bulk acknowledgement are idempotent; acknowledged incidents suppress incident retries/reminders; recovery still resolves them; a later post-recovery failure creates a new incident.
- Verification: Repository/API lifecycle tests.
- Evidence: Alert lifecycle tests passed. Single and bulk acknowledgement are idempotent, acknowledged incidents remain open while suppressing repeat delivery, recovery resolves the original incident, and a later failure opens a new incident.

### T-205 Settings and Alerts UI

- State: `done`
- Scope: `public/index.html`, `public/app.js`, `public/styles.css`.
- Purpose: Centralize safe operational controls and make alert handling efficient.
- Pressure check: A large settings surface can become unreadable or allow accidental expensive changes. Use tabs, explicit units/ranges, environment-lock feedback, and confirmations for enabling or shortening paid probes.
- Acceptance: Notification Rules, Automatic Tasks, Upstream Policies, and Retention tabs work; current values load; saves show authoritative results; Alerts supports Pending, Handled, Recovered plus single/bulk handling; desktop/mobile layout remains coherent.
- Verification: Browser interactions at desktop and 390x844, console/network inspection, and API round trips.
- Evidence: Browser verification passed against the real upstream at the existing desktop/mid-size viewport and Chrome's explicit 390x844 viewport. All four settings tabs rendered, the upstream policy row saved successfully, isolated fixture alerts proved single and filtered bulk acknowledgement, and temporary fixtures were deleted. A stale bulk-button state found during testing was fixed and retested; mobile root/content widths stayed within the viewport while wide tables scrolled inside their own containers.

### T-206 Documentation and compatibility polish

- State: `done`
- Scope: relevant README/deployment documentation and whole-diff cleanup.
- Purpose: Explain precedence, costs, acknowledgement semantics, and restart behavior accurately.
- Acceptance: Documentation distinguishes environment locks, runtime controls, per-upstream overrides, paid probes, manual model sync, handled incidents, and real recovery.
- Verification: Documentation/diff review and stale-copy search.
- Evidence: README, deployment guidance, and `.env.example` now document scheduler hard locks, hot database settings, per-upstream precedence, paid probes, manual model-catalog sync, and handled-versus-recovered semantics. Legacy notification counts are normalized during migration, covered by a focused migration fixture. Focused tests passed 16/16; syntax and diff checks passed.

### T-207 Whole-change verification and delivery

- State: `done`
- Scope: full test suite, syntax/security scans, browser verification, one real PushPlus test, final process.
- Purpose: Prove the settings-to-runtime and alert lifecycle end to end and leave an inspectable server.
- Pressure check: Unit tests could pass while the running process still caches old settings or the UI saves a different schema. Exercise the live server without running a full paid probe batch, then restore the user's saved settings.
- Acceptance: Full suite passes; no secret leaks; live save/read/restore works without restart; acknowledgement is visible; one labeled PushPlus test is sent; server is left running on port 4317 with the user's effective settings.
- Evidence: Full suite passed 48/48, all JavaScript syntax checks and `git diff --check` passed, and `npm audit --omit=dev` reports 0 vulnerabilities after updating the patched transitive `body-parser`. API scans confirmed all operational routes remain behind `/api` authentication and no real secrets were added to the diff. One labeled `Sub2API 控制台测试` PushPlus message returned code 200. Runtime test settings and fixture alerts were removed. The final plain `.env` server reports default-source settings with no environment locks; desktop/mid-size and Chrome 390x844 browser checks show no page-level overflow or console warnings/errors.

## Completion

- State: `complete`

## Current Goal: Multiple PushPlus Targets

Status: complete

Mode: `state-main`
Topology: `linear`

Outcome: Broadcast every alert to all enabled PushPlus targets while preserving legacy single-token and environment fallback behavior.

Tasks:

- T-001 encrypted target model and legacy compatibility: done
- T-002 broadcast delivery and isolated failures: done
- T-003 API and settings UI: done
- T-004 tests, documentation, and final verification: done

Pressure check: The environment token is used only when no database target list exists, preventing duplicate delivery after upgrade. Full tests cover legacy resolution, masked status, enabled-target fan-out, and partial failure.

Evidence: `npm test` passed 59/59; JavaScript syntax checks and `git diff --check` passed. Real PushPlus delivery remains user-assisted because no production token was supplied in this task.

## Current Goal: Balance confirmation and per-Key scheduled probes

Status: complete

Mode: state-main
Topology: linear
Git baseline: clean before this goal; prior user history preserved

Outcome: Prevent transient zero-balance readings from triggering false alerts, and make scheduled connectivity probes opt-in per Key with an explicit model.

Tasks:

- T-001 data model and migration: done
- T-002 zero-balance confirmation: done
- T-003 per-Key scheduling and alert exit: done
- T-004 UI and whole-change verification: done

Pressure check: manual checks remain unrestricted; only the scheduler filters opt-in Keys. Disabling a schedule resolves its open incident directly without sending a recovery message.

Evidence: T-001 focused migration/repository tests passed 12/12. T-002 sync/alert tests passed 20/20. T-003 focused scheduling/repository tests passed, including silent alert resolution and explicit per-Key model gating. Full suite passed 77/77; syntax and diff checks passed.

## Current Goal: Strict balance validity and false recovery prevention

Status: complete
Mode: state-main
Topology: linear
Git baseline: clean commit `fe26fe8`; production runs the same commit

Outcome: Missing Sub2API balance fields must preserve the last valid snapshot and must never open a false zero-balance incident or trigger a false recovery notification.

Tasks:

- T-001 production evidence and field semantics: done
- T-002 strict parsing, confirmation, monitoring, and alert handling: done
- T-003 regression verification: done
- T-004 production backup, release, and observation: done

Pressure check: A real zero must remain representable, while missing values, empty strings, and unrelated quota/credit fields must not become money. Two explicit zero reads confirm a real zero; missing reads fail the sync and preserve the prior snapshot.

Verification evidence: Focused balance-path tests passed 32/32. The full suite passed 82/82, JavaScript syntax and `git diff --check` passed, and `npm audit --omit=dev` reported 0 vulnerabilities.

Production evidence: SQLite backup `/var/backups/sub2api-upstream-console/20260802T013226Z/upstream-console.sqlite` passed `PRAGMA integrity_check`. Production advanced to `fb0ad740eb46befeec963d739c5bc5b832abf205` (v1.8.4), restarted successfully, `/api/health` returned HTTP 200, and the latest five Dream syncs all succeeded with balance `7.2459463` and zero sync failures.

Status: complete

## Current Goal: Homepage upstream consumption and model testing

Status: implementing
Mode: `state-main`
Topology: `linear`
Git baseline: clean `main` at `fb0ad74`; upload target confirmed as `origin/main`

Outcome: Make the monitoring homepage show each upstream's balance consumption, burn speed, and runway across 24-hour, 7-day, and 30-day periods, while surfacing model synchronization beside the existing per-Key model selector and explicit connectivity test.

Confirmed decisions:

- Preserve the current dollar-style balance display without currency conversion.
- Persist a Key's selected model, but send a real probe only after an explicit "立即检测" action.
- Reuse snapshot history, model discovery, and connectivity services; use lightweight native SVG/CSS rather than adding a chart dependency.

Scope and non-goals:

- Allowed writes: relevant `src/`, `public/`, `test/`, `WORK_STATE.md`, and documentation only when required for changed behavior.
- Do not change real Key status, create/delete real Keys, add currency conversion, change snapshot retention policy, or make model selection trigger inference.
- Real upstream model/probe behavior is verified only when an already-configured non-critical fixture is safely available.

Tasks:

- T-001 trend aggregation and API: done
- T-002 homepage consumption UI: done
- T-003 homepage model sync and Key probe workflow: done
- T-004 regression, browser, real-environment verification, and upload: done

T-001 pressure check: Tests could pass while recharge jumps, cumulative-cost resets, or partial coverage produce misleading speed and runway values. The implementation must distinguish cost-derived data from balance estimates, ignore negative cumulative deltas, report actual coverage, and withhold derived values when fewer than two valid samples or less than one hour of coverage exist.

T-001 evidence: Focused trend and monitoring tests passed 8/8. Syntax checks and `git diff --check` passed. The API returns fixed 24/28/30-bucket payloads, actual coverage, cost-versus-estimate provenance, and null speed/runway for insufficient data.

T-002 pressure check: Adding several metrics to the dense monitoring page could bury the main Key workflow or create mobile overflow. Keep comparison charts compact, make one upstream detail selected at a time, preserve the existing expandable table, and constrain wide content to its existing scroll boundary.

T-002 evidence: The monitoring page now renders a responsive period selector, Top 10 comparison, single-upstream SVG balance/consumption chart, coverage/provenance, and complete table metrics. JavaScript syntax, focused tests, and diff checks pass; browser verification remains in T-004.

T-003 pressure check: A successful model endpoint call could still leave stale selectors if the monitoring payload lacks persisted sync metadata, while auto-probing on selection would violate the confirmed paid-request boundary. Persisted catalog state must be summarized in monitoring, explicit model sync must refresh selectors without collapsing the site, and selection must remain a save-only action.

T-003 evidence: Related model, connectivity, monitoring, repository, and trend tests passed 38/38. Monitoring now exposes persisted model count, group count, sync time, and partial/stale status. The expanded homepage row has an explicit model-sync action; the existing model selector remains save-only and the existing activity button remains the sole manual probe trigger.

T-004 pressure check: A clean unit suite could still hide broken SVG geometry, table colspan errors, mobile page overflow, or an authenticated fixture that accidentally reaches real upstreams. Browser checks must run against an isolated database with both schedulers hard-disabled, exercise period/site/expand interactions, and inspect console, network, and viewport overflow before upload.

T-004 evidence: Full `npm test` passed 88/88. All JavaScript syntax checks and `git diff --check` passed. The isolated fixture browser rendered the non-empty SVG chart, switched to 7 days, selected an upstream, and expanded its Key panel with the homepage model-sync action; page-level horizontal overflow was false, and the browser reported no warning/error logs. The 30-day API returned 4 upstreams with 30 buckets each. No real upstream or paid probe was used.

## Completion

Status: complete
Delivery: committed and pushed to `origin/main` after final review.

## Current Goal: Safe upstream deletion and target New API compatibility

Status: complete
Mode: `state-main`
Topology: `linear`
Git baseline: clean at `f0020c4`; no pre-existing worktree changes

Outcome: Keep upstream removal reversible by default, require explicit confirmation for permanent local deletion, and improve compatibility with the user-provided New API site without changing remote state.

Confirmed decisions:

- T-001: expose existing reversible `active`/`disabled` status and add a two-step permanent deletion flow.
- T-002: prioritize `https://new.178266.xyz` and common response variations rather than all New API forks.
- T-003: use the supplied account only for an isolated, read-only real sync; never persist credentials or mutate remote resources.

Scope and non-goals:

- Allowed writes: relevant `src/`, `public/`, `test/`, `README.md`, `TODO_CN.md`, and this state record.
- Do not create, delete, or modify remote Keys, subscriptions, payments, or account data.
- Do not add a broad fork-specific compatibility matrix without evidence from the target site.

Tasks:

- T-001 deletion workflow: done
- T-002 New API adapter compatibility: done
- T-003 regression and isolated verification: done
- T-004 real read-only sync, documentation, and final review: done

T-001 pressure check: permanent deletion must not be discoverable as a routine edit action, and local cascade behavior must be proven for credentials and telemetry. The UI uses a separate danger zone with two confirmations; the API validates the ID and returns 404 for a missing site. Focused verification is the cascade test and frontend/API syntax review.

T-001 evidence: `test/upstreamDeletion.test.js` passed; isolated HTTP flow created, disabled, deleted, repeated delete (404), and confirmed monitoring cleanup.

T-002 pressure check: broad New API fork support could obscure the target site's actual response shape. The adapter extends existing paths only where fixture and target evidence support it, keeps quota-only stats distinct from request/token totals, and maps numeric Key status into the existing UI contract.

T-002 evidence: fixture tests cover code 200, array groups, paginated Keys, usage aliases, and numeric statuses. Real target sync succeeded on New API `v1.0.0-rc.23`; `/api/pricing` returned usable pricing, `/api/ratio_config` returned 403 and was retained as a warning.

T-003 evidence: full `npm test` passed 92/92; JavaScript syntax checks and `git diff --check` passed.

T-004 delivery note: the execution environment DNS maps public hosts to `198.18.0.0/15`, which the production SSRF guard correctly rejects. Real validation used a temporary process-only DNS precheck override for the supplied public hostname; production code and its guard were not weakened. No remote mutation was performed.

T-004 evidence: final real read-only sync returned provider `new-api`, one Key normalized to `active`, three rates, sixteen pricing items, a numeric balance, and one expected `/ratio_config` warning. No server process was left running and no credentials were written to the repository.

Completion: complete
