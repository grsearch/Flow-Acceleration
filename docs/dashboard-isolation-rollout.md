# Dashboard isolation and raw-write compatibility

## Scope

This change does not place orders, enable a disabled strategy, change wallet
votes, relax entry/exit guards, or modify historical returns. HO500 remains the
already-configured `graduation_accel_o_c80_ho500_x60_live` at 0.1 SOL. The directory
now comes from actual loaded configuration, independently of statistics.

The raw writer accepts pre-execution-context queue rows at both final write
boundaries. Missing `pool` and reserve fields become NULL, not reconstructed
market facts. Queue failures retain the batch for retry, and binding errors are
reported separately from SQLite lock contention.

## Runtime layout

- The collector keeps all trading and stream ownership.
- For file-backed databases, a supervised child serves HTTP. It receives only
  sanitized configuration and memory-based runtime snapshots, with no signing
  credentials, stream client, or writable research-store connection.
- HTTP reads an in-memory snapshot map. FAST and HISTORY workers independently
  read the research database in read-only/query-only mode and persist whole
  snapshots to the separate Dashboard database. FAST includes live strategy
  statistics; heavy Shadow and wallet research cannot occupy that worker.
- Per-key cooldowns, hung-worker recovery, inactive-strategy refresh intervals,
  payload/cache/heap limits bound background work. Cold cached snapshots hydrate
  asynchronously. Statistics are not incrementally approximated or truncated.
- Ad-hoc backtests have one bounded worker, a deadline and bounded result cache.
  Different simultaneous requests return BUSY instead of spawning extra workers.
- HTML/JS and API payloads support gzip. Detail rows are limited for transport,
  while totals/cohorts remain unchanged. The UI has independent catalog/detail
  deadlines and explicit missing, stale, preparing and error states.

## Before production rollout

Do not blindly restart a process with an undrained raw queue. Its existing
in-memory data is **not made persistent by this patch**. Record pendingWrites,
pendingLabelWrites, pendingTokenWrites, queuedTradeLagMs and lastWriteError first.
If pending writes cannot drain, stop the rollout and preserve/recover them via an
approved maintenance procedure before restarting. Never clear buffers, delete
WAL/SHM, start a second writer, or overwrite unrelated production edits.

Use only the established production checkout and systemd service. Inspect local
diffs and confirm the expected complete commit before updating; do not deploy
individual files. New files include `dashboard-child.js`, the process/query/asset
helpers, `dashboard-runtime.js`, runtime integrity and snapshot task adapters.

The production defaults enable the independent process. Existing explicit
`FLOW_DASHBOARD_CACHE_ENABLED=false` or `FLOW_DASHBOARD_PROCESS_ENABLED=false`
opts out; investigate these settings rather than silently overriding them.
Do not lower the HTTP heap while raising payload budgets without measurement.

## Read-only acceptance checks after an authorized rollout

1. Run `node scripts/check-runtime-integrity.js --expected-commit=<full-commit>` from the
   production checkout. It prints fixed-file hashes and safe configuration
   summaries, never `.env` or secrets. Confirm the expected commit and MATCH.
   UNKNOWN means verification unavailable, not proof of corruption. Startup
   health includes a separate captured integrity snapshot; later disk updates
   do not alter the already-running process configuration.
2. `/api/strategy-status`: HO500 code/id, 0.1 SOL, enabled and entryEnabled should
   agree with intended configuration. Check the HO500 Shadow handoff/capacity in
   configurationIntegrity.configSummary too. Do not enable legacy recovery as a
   substitute. Disabled strategies should remain visible but grey.
3. `/api/health`: runtimeSnapshot.mode should be INDEPENDENT_HTTP_PROCESS and its
   dashboardPid distinct from runtime.pid. Runtime sample age should stay below
   15 seconds; if stale, the collector may be blocked even when the page responds.
4. Check database pending queues decrease, persisted trades advance and binding
   errors do not recur. A responsive page alone does not verify collection or
   live trading readiness.
5. Check Dashboard FAST/HISTORY worker status, per-key errors, snapshot times and
   memory budgets. Slow research may legitimately show STALE/PREPARING; it must
   not present invented zero counts. Verify active live statistics advance while
   a history refresh runs. Inspect repeated errors rather than restarting in a loop.
6. Measure HTML transfer, directory response, selected strategy details and
   collector data latency repeatedly, both cold and warm. Local fixture tests
   prove isolation/correctness, not production latency on a 17+ GB database.
7. Confirm only one collector owns the production database and its supervised
   Dashboard child owns the port. A separate HTTP child is intentional, not a
   second trading instance. Manage both through the collector's existing service.

Raw daily rotation remains unchanged, with read views refreshed when the day or
writer's shard marker changes. No production database, timer or export has been
modified by this local implementation.
