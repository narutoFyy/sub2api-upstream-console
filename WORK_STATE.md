# WORK_STATE

## Execution

- Mode: `state-main`
- Topology: `linear`
- Outcome: Make PushPlus configurable, synchronize selectable probe models, restore trustworthy Key actions and hierarchy, remove desktop-only navigation controls, and expose real per-request upstream usage.
- UI direction: Preserve the approved operations-console visual language and information density.
- Non-goals: No automatic upstream switching, disabling, Key deletion, local usage-log mirroring, or real destructive Key verification.
- Git baseline: Clean `main` worktree at `9d314c1`.

## Delivery Truth

- Local verification: migrations, encrypted settings, model discovery fallbacks, Key mutation reconciliation, sanitized usage proxy, responsive browser flows, and the full automated suite.
- Real-environment verification: read-only model/usage queries against the connected Sub2API upstream.
- User-assisted verification: actual PushPlus delivery after a token is saved in Settings.
- Destructive real-Key operations remain unverified unless the user supplies an expendable Key; simulated integration coverage is required instead.

## Tasks

### T-001 Settings and model data structures

- State: `done`
- Scope: `src/db.js`, `src/repository.js`, migration/repository tests.
- Purpose: Persist encrypted PushPlus configuration, discovered group/model candidates, and selected per-group probe models without exposing secrets or breaking existing databases.
- Pressure check: A migration can pass while losing existing settings or making model mappings stale. Use additive tables, unique constraints and replace-by-upstream transactions; prove upgrade compatibility and token masking.
- Acceptance: Existing database opens unchanged; encrypted token round-trips only inside the repository; group model candidates and selections can be replaced/read deterministically.
- Verification: Focused migration/repository tests and `node --check`.
- Evidence: `node --test --test-concurrency=1 test/migration.test.js test/settingsRepository.test.js` passed 3/3; transition `implementing -> main_verify -> done`.

### T-002 PushPlus settings

- State: `done`
- Scope: PushPlus client, server routes/schemas, Settings UI, focused tests.
- Purpose: Configure, clear and test PushPlus from the console with database-first and environment fallback behavior.
- Pressure check: A settings form can appear saved while the notifier still reads startup configuration, or can leak the token in status JSON. Resolve the token at send time, return only mask/source, and verify save-test-clear through HTTP.
- Acceptance: Full token never leaves the backend; saved token survives restart; test and clear have explicit results.
- Evidence: Syntax checks passed; PushPlus/repository tests passed 7/7; transition `implementing -> main_verify -> done`. HTTP save/clear remains in T-007 end-to-end verification.

### T-003 Model synchronization and group-aware probes

- State: `done`
- Scope: upstream/model services, connectivity resolver, server routes, upstream form/settings UI, focused tests.
- Purpose: Discover models per group, retain usage/manual fallbacks, and let each Key use its group selection.
- Pressure check: Treating a site-wide model list as proof of every group causes false Key failures. Discover per group, label fallback sources, preserve manual selections, and verify model resolution for different group IDs.
- Acceptance: `/v1/models` success is used; 403 groups get recent-usage candidates; manual fallback remains; checks resolve the group mapping.
- Evidence: Model/connectivity/repository tests passed 10/10 and syntax checks passed; transition `implementing -> main_verify -> done`. Real upstream sync remains in T-007.

### T-004 Key management hierarchy and reliable mutations

- State: `done`
- Scope: Key routes/client, repository reconciliation, Key UI and focused tests.
- Purpose: Default to collapsed upstream rows and ensure enable, pause and delete remain correct after refresh.
- Pressure check: Awaiting a broad site sync can still resurrect deleted Keys if reconciliation reads stale or unrelated snapshots. Reconcile the complete live Key list synchronously after the mutation, return the reconciled state, and exercise refresh behavior with a stateful fake upstream.
- Acceptance: Mutations await reconciliation; errors do not produce optimistic false states; delete requires confirmation.
- Evidence: Key mutation/import/monitoring tests passed 8/8 and syntax checks passed; transition `implementing -> main_verify -> done`. Real destructive Key verification remains explicitly excluded.

### T-005 Desktop navigation controls

- State: `done`
- Scope: `public/styles.css`, responsive browser checks.
- Purpose: Hide sidebar close/menu controls on desktop while retaining mobile navigation.
- Pressure check: A specificity fix can hide mobile navigation too. Use matching high-specificity desktop and media selectors, then verify computed display values at both breakpoints.
- Acceptance: No unwanted desktop controls; mobile open/close remains usable.
- Evidence: Headless Chrome computed both controls as `none` at 1440px and `flex` at 390px; transition `implementing -> main_verify -> done`.

### T-006 Upstream request usage

- State: `done`
- Scope: upstream usage adapter, sanitized routes, sidebar/view UI and focused tests.
- Purpose: Show real paginated per-request records from one selected upstream without local mirroring.
- Pressure check: A raw proxy could leak full Keys, account objects or unbounded query behavior. Whitelist request parameters and response fields, select one upstream at a time, and prove sanitization with deliberately hostile fixtures.
- Acceptance: Filters, pagination and details work; full Keys, credentials and raw upstream objects are never returned.
- Evidence: Usage/Key mutation tests passed 6/6; real upstream list returned 17,257 records and detail lookup succeeded with no forbidden fields or full-Key pattern; transition `implementing -> main_verify -> done`.

### T-007 Whole-change verification and polish

- State: `done`
- Scope: tests, browser checks, documentation where configuration behavior changed.
- Purpose: Prove cross-task workflows, responsive layout, security boundaries and real read-only integrations.
- Pressure check: Individual APIs can pass while navigation never loads data, responsive filters overflow, or real upstream capability differs from fixtures. Exercise complete browser journeys, inspect console/network errors, and distinguish real read-only proof from unverified PushPlus delivery and destructive Key actions.
- Acceptance: Full suite passes; desktop/mobile flows pass; real usage/model reads pass; server is left running on port 4317.
- Evidence: `npm test` passed 29/29 and all JavaScript syntax checks passed. Real upstream usage list/detail returned sanitized records with local Key/group enrichment. Real model sync found 8 groups: 2 live, 4 usage fallback, 2 unavailable; stored errors contain no raw IP. Headless Chrome verified Key accordion, usage pagination/detail, eight model selectors, PushPlus form, desktop/mobile navigation, no page overflow, no console errors, and no failed HTTP responses. Transition `implementing -> main_verify -> done`.

## Completion

- State: `complete`
- Server: `http://localhost:4317` in exec session `84479`.
- Real-world gaps: PushPlus delivery awaits a real token and user confirmation in WeChat. Destructive real-Key delete was not exercised; stateful fake-upstream tests cover enable, pause, delete and failed mutations.
