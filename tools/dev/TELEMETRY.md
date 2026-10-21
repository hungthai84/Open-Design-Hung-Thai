# Local telemetry acceptance

`tools-dev` loads environment files and inspects the running daemon. It does not enable consent, change a relay destination, send a synthetic trace, or generate a model task automatically.

Configure the current checkout's `.env.local` (or pass `--env-file` explicitly):

```dotenv
OPEN_DESIGN_TELEMETRY_RELAY_URL=<team relay for the ODEval query environment>
OD_TELEMETRY_ENV=local_development
```

Alternatively, authorized developers can configure `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` for direct delivery. Never commit keys. `OD_TELEMETRY_ENV` is a trace label, not a destination or consent switch. A Vela login alone does not configure OD Next Task delivery.

Enable both usage and content consent in the client's privacy settings. Follow the root `AGENTS.md` **Daemon data directory contract** for data isolation. Reuse your existing namespace and data-root configuration when restarting:

```bash
pnpm tools-dev restart --namespace qa-trace --env-file .env.local
pnpm tools-dev check telemetry --namespace qa-trace --json
```

`--no-env-file` skips environment-file loading. Loading a file in a status/check command does not update an already-running daemon. The report labels file provenance as the current CLI invocation; the daemon's effective sink, environment, protocol and consent are authoritative. Start/restart/run prints a telemetry summary to stderr, preserving JSON stdout. Status/check includes diagnostics; missing or older daemons report an explicit unavailable/unsupported state.

Complete one identifiable test conversation through the client. `check telemetry` lists the 20 most recently updated Task delivery records, including stored exporter Trace IDs. Records from before identity recording was added have `traceId: null`; the tool never guesses their protocol from current configuration. This first version covers OD Next Task traces, not standalone legacy Run traces or PostHog events.

Authenticate the existing ODEval CLI, then verify the exact recorded ID:

```bash
od-evals auth login
pnpm tools-dev verify telemetry --namespace qa-trace --trace-id '<recorded-id>' --json
# Optional: --odeval-profile <existing-profile>
```

Verification looks up that exact local ID even when it is older than the recent list. It requires current configuration readiness, local `accepted`, and exactly one remote trace matching Trace ID, Task ID, conversation ID and environment. The command exits 0 only for `verified`; absent identity, pending/failed delivery, unavailable ODEval, permissions, 404 and mismatches exit 1. Remote readback is bounded to 45 seconds with no automatic retry or model rerun. If ingestion is still pending, retry explicitly later. Remote response bodies and credentials are not printed. `accepted` alone never becomes `verified`.

Daemon/API equivalent: `od telemetry status --json`, `GET /api/telemetry/diagnostics` (local requests only).

## Alignment and acceptance

Source: user-approved tools-dev telemetry workflow, 2026-10-19; implementation baseline `770232362`.

| ID | Confirmed behavior | Validation |
|---|---|---|
| T1 | Runtime consent/sink readiness, independent of invoking shell | daemon HTTP tests; isolated daemon missing-sink/configured checks |
| T2 | No secret/content output; local-only diagnostics | origin rejection, bounded allowlisted response, opaque-error tests |
| T3 | Persist export identity; old records stay unknown | SQLite and real exporter regression tests |
| T4 | Exact remote identity required; failures exit nonzero | verifier identity/error tests and real CLI readback |
| T5 | Existing startup/status remain usable without telemetry | tools-dev regression tests and missing-sink startup |

No new telemetry consent or destination defaults; no deployment or automatic publication. Remote reachability is a separate acceptance result from configuration readiness.
