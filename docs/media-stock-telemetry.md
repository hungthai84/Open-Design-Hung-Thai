# Stock-search diagnostics and analytics

`od media stock-search` keeps provider search/download attempts in stdout JSON
and streams diagnostics to stderr. It additionally journals content-free
request results and final slot results under the daemon's resolved data root.
Data ownership and propagation follow [AGENTS.md](../AGENTS.md#daemon-data-directory-contract).
There is no project-cwd or user-home fallback when `OD_DATA_DIR` is absent.

The JSON result includes `telemetry.callId` and `telemetry.collectionStatus`.
The call id names its JSONL journal and delivery receipt. `complete` means all
request results and one final result per input slot were written locally; it
does not mean PostHog has indexed them. `failed` means local capture failed,
including capacity or filesystem errors. Image acquisition continues either way.

The running daemon checks for completed journals every 30 seconds, at most four
calls per pass. Each call sends one HTTP batch, at most 150 events / 256 KiB.
Delivery failures use exponential backoff from one minute to 30 minutes and
retain the journal. Stable `$insert_id` values survive retransmission. A 2xx
receipt means ingestion accepted the batch, not query-visible completeness;
an ingestion `quota_limited` response remains retryable. A daemon with no
PostHog configuration never starts this collector. CLI execution does not
wait for a network upload or create a PostHog client. Graceful daemon shutdown
also makes a bounded two-second delivery pass; undelivered records remain retryable.

Journals are limited to 256 KiB per call, with a 32 MiB / 1024-call spool
admission ceiling. Admission uses an atomic cross-process lock with a 250 ms
contention budget and reserves maximum size for each active call. Completed,
acknowledged or consent-disabled journals are retained seven days;
pending and invalid records are retained until admission fails. Active journals
are considered partial only after ten minutes and after their writer exits.
An interrupted final line is ignored; complete, malformed lines fail validation.
This is local diagnostic retention, not an unlimited historical archive.

Metrics consent is recorded when the call starts and rechecked before upload.
An opted-out call, including one disabled before upload, is never retroactively
uploaded after consent changes. Missing sink configuration or identity stays retryable.
No query, slot label, prompt, URL, output path, API key, or free-form error is
sent in analytics. `slot_index` distinguishes repeated labels; `credential_ref`
is a truncated SHA-256 fingerprint of a high-entropy provider key, never the key.
Detailed scrubbed failures remain in the CLI execution output.

## Events and attribution

- `media_stock_request_result`: one event per observed provider search or
  download outcome, including HTTP status, error category, monotonic duration,
  Pexels quota fields and normalized Retry-After. Download duration includes
  image inspection and writing bytes. Null quota fields remain unknown.
- `media_stock_slot_result`: one final result per input slot. Pexels attempts,
  fallback attempts, fallback reason and successful Pixabay recovery are
  explicit fields. Duration is the sum of its observed request-stage durations.

Upload device/session identity is pinned in the journal when collection starts;
Run cleanup or installation identity changes cannot reassign a retry.

Both carry call id, slot index, run/project/node/evaluation association, source commit when
provided, execution source, schema version and collection status. All agent
runtimes receive the current run/session association from the daemon. Standalone
calls retain null Run ids. `OD_STOCK_SOURCE_COMMIT` is an optional exact source
identity supplied by the launch environment; absent identity stays null, never
inferred from an application version. `OD_STOCK_EXECUTION_SOURCE=validation`
keeps authorized instrumentation checks separate from product traffic.
Evaluation launchers can supply `OD_STOCK_EXECUTION_SOURCE=evaluation`,
`OD_STOCK_NODE_ID`, `OD_STOCK_EVALUATION_RUN_ID` and `OD_STOCK_CASE_ID`.
These associations stay null when the launcher does not supply them.

## Dashboard definitions

Use the same time range and filters for all counts, rates and durations. Exclude
`execution_source=validation` from product metrics and expose collection status.
Use request events for traffic/error rates and slot events for recovery rates.

| Metric | Definition |
| --- | --- |
| Pexels API volume | Pexels request events with stage=search |
| Pexels API 429 rate | Search events with HTTP 429 / observed Pexels search events |
| Pixabay fallback rate | fallback_attempted slots / pexels_attempted slots |
| Recovery success rate | fallback_succeeded slots / fallback_attempted slots |
| Latest known monthly quota | Latest non-null quota response per credential_ref and reset window, with observation time |
| Latency | P50/P95 duration, split by provider and search/download |

CDN 429s are separate from search API limits. Monthly headers do not describe
the hourly remaining budget. A 429 alone does not establish which window was
exceeded. Do not sum remaining quota or replace unknown values with zero. Call
counts cover only instrumented stock-search traffic; other uses of a shared
key are reflected in provider quota snapshots, not in these event counts.

Before creating or relying on a dashboard, reconcile a real CLI call's journal
event ids/counts with its receipt and PostHog query results. A mock test or HTTP
200 alone does not establish that reconciliation.
