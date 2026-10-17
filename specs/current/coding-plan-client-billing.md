# Coding Plan client billing

The Vela Coding Plan rollout replaces the wallet-only zero-balance admission
rule in T55/T66. Zero wallet balance is not proof that an AMR run cannot start.
The existing removal of positive low-balance warnings remains in force.

## Authority and compatibility

- Link owns per-request model access, Coding Plan admission, wallet fallback,
  free-model handling and automatic recharge. Preflight does not reserve quota
  or guarantee that a whole agent run can complete.
- The daemon reads `vela billing preflight --workspace-id <id> --model <model>
  --format json` through the existing session/environment-aware CLI adapter.
- `/api/workspace/billing?scope=workspace&workspaceId=<id>&includePreflight=1`
  includes an optional `preflight`; optional `modelId` selects model coverage.
  Both wallet and preview must match the directory-verified member identity.
- `funding` is `coding_plan`, `wallet`, or `gateway`. The latter means the
  gateway must decide, not that the client should block. Coverage is advisory
  and does not replace membership/model-access checks.
- Old CLIs, missing capability, and unavailable usage do not synthesize zero
  quota. Existing exact workspace/member authorization still fails closed.
- `od workspace billing --workspace-type personal|team --workspace <id>
  [--model <id>] [--json]` exposes the same daemon response.

## User behavior

- Home and project sends do not block or show a balance card merely because
  the wallet is zero. Confirmed sign-out and invalid workspace authority retain
  their existing handling. Actual gateway insufficient-balance failures retain
  the existing error/recharge experience.
- The billing panel displays each member Coding Plan window separately from
  wallet money. Windows are simultaneous limits, not additive balances; none
  are labelled unlimited. Paid team seats are included.
- While open, the panel refreshes every 30 seconds and at a window reset; it
  does not depend on wallet SSE events. A failed read is shown as unavailable.
- Recovery polling is bound to the original workspace/member and selected
  model and requires positive funding evidence before resuming.

## Rollout and verification

Deploy the Vela API and distribute the new CLI to enable usage display. The
Open Design send fix remains compatible with older CLI/server combinations.
Unit/route/component tests cover dual-window exhaustion, member mismatch,
model propagation, old CLI behavior, zero-wallet sends, sign-out, and refresh
after quota reset. Final admission under concurrent usage remains Link-owned.

## Shared task final admission

The existing `POST /api/runs` response stays `202`: the daemon accepted a local
queue item, not a workspace task slot. For AMR, `start` is emitted only after
`vela run lease admit` succeeds (or the server explicitly reports the rollout
is disabled), before the child starts. The existing CLI follows this same run
and event stream; it does not have a separate admission bypass.

The project composer retains its submitted snapshot until this start event.
A final rejection, connection failure, or cancellation before start hands the
prompt and attachments back. A later start cannot reverse cancellation or
clear a new draft. Editing text, staging attachments, or changing draft scope
prevents restoration over that later draft; the original submitted message
remains in history. Home preflight continues to precede project creation;
queued Home input is retained by the project history if final admission fails.

`start` consumers were checked: runtime analytics and diagnostics now begin
only for an admitted execution; persisted chat status, attempt bookkeeping,
and the CLI keep consuming the same event shape. The protocol version and
HTTP response shape are unchanged.

Validation: `shared-task-admission-draft.test.ts` uses the real browser, daemon,
Vela CLI, owned AMR API/Link/Postgres/Redis. Its transport barrier changes only
the fixture balance after real preflight and before forwarding the real run
POST; it does not fake either response. Provider output is a local fixture.
The focused composer/ProjectView tests separately cover later edits and late
start/cancel ordering. This is not evidence of every RUN case or every plan's
production concurrency configuration.

## Attachment upload gate (2026-10-17 confirmed follow-up)

Final-admission recovery must distinguish a submitted attachment from an upload
placeholder. Tests wait for upload completion and assert the actual run POST
contains the file; a filename appearing in the tray alone is insufficient.

For the related incomplete-upload defect, the confirmed scope is narrow: while
any selected file is preparing or uploading, both Send and Enter retain the
current text and send nothing. Completing, failing, or canceling an upload
re-enables manual sending when the remaining draft is otherwise sendable; it
never submits automatically. A canceled upload's late response cannot reattach
the file. Failed attachments retain the existing per-file retry/removal flow.
This supersedes only the old chat-redesign note that deferred this known bug;
it does not change upload storage, task admission, or later-draft protection.

The CLI already submits server-backed attachment paths and has no browser
upload placeholder. This guard is specific to the browser composer, with the
same daemon run endpoint unchanged. Component tests cover the shared button /
Enter gate and completion/failure/cancellation; the real-daemon browser case
holds the actual upload response and then submits the stored attachment.
