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
