// Reusable "invite teammates" dialog for the team workspace.
//
// Opened from the team dropdown in the left rail. Ported VERBATIM (markup +
// classes) from the design demo (origin/demo/workspace-team-features) — the
// Canva-style two-column layout: form on the left, decorative avatar-cluster art
// on the right. The ONLY difference from the demo is the submit: instead of the
// demo's no-backend `onSubmit` stub, "确认并邀请" POSTs the collected
// { email, role } rows to the real daemon endpoint (`POST /api/workspace/invite`),
// which creates each invite on B with the signed-in vela session. On success the
// dialog shows a brief success state and closes; on failure it surfaces an inline
// error and stays open. The UI never blocks on the backend being present.

import { useEffect, useRef, useState } from 'react';
import {
  normalizeWorkspaceInviteCreateErrorCode,
  type WorkspaceCollabContext,
  type WorkspaceInviteRole,
} from '@open-design/contracts';
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import { SeatFreeCopyInviteLink } from './SeatFreeCopyInviteLink';
import {
  DEFAULT_INVITE_ROLE,
  InviteRowsEditor,
  inviteRowErrors,
  inviteRowsEmpty,
  type InviteRow,
  type InviteRowsEditorEvent,
} from './InviteRowsEditor';
import { useI18n } from '../i18n';
import { workspaceInviteErrorMessageKey } from '../collab/invite-error-copy';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { readSeatFreeMock, SEAT_FREE_MEMBER_EMAILS } from '../mock/seat-free';
import { useAnalytics } from '../analytics/provider';
import {
  trackWorkspaceInviteClick,
  trackWorkspaceInviteResult,
  trackWorkspaceSurfaceView,
} from '../analytics/events';
import {
  countBucket,
  stableAnalyticsErrorCode,
  workspaceAnalyticsDimensions,
} from '../analytics/workspace';

export type { InviteRow };

interface Props {
  open: boolean;
  onClose: () => void;
  /** Identity the host already resolved for this invite mutation. */
  workspaceContext: WorkspaceCollabContext | null;
  /** Shows "你的团队有 1人" for single-seat plans (vs the team default). */
  freePlan?: boolean;
  /**
   * Seats the workspace can still fill. The daemon already computes this
   * (`seatSummary.availableSeats`); until this dialog consumed it, a workspace
   * with zero seats let the user type addresses, press 确认并邀请, and get a
   * per-row failure back from B — the plan limit surfaced as a send error
   * rather than as the reason they cannot invite yet (#115).
   *
   * `undefined` means "seat state unknown" and stays permissive, so a context
   * that has not loaded yet never blocks a workspace that does have seats.
   */
  availableSeats?: number;
  /** Opens B's plan-change flow. Rendered only when seats run out. */
  onUpgrade?: () => void;
  /** Called with the entered rows when "确认并邀请" is pressed. The host
   *  decides whether to send invites directly or route through upgrade. */
  onSubmit?: (rows: InviteRow[]) => void;
  /** Owner / Admin can choose roles; Member invites with the default role. */
  canAssignRoles?: boolean;
  /** The entry point that opened the dialog, used for the invite funnel. */
  entryFrom?: 'workspace_switcher' | 'all_projects';
}

const DEFAULT_ROLE = DEFAULT_INVITE_ROLE;

// Map the dialog role value to the canonical assignable role B expects
// (never 'owner'). Legacy Chinese labels are accepted for existing state.
function toCanonicalRole(role: string): WorkspaceInviteRole {
  return role === 'admin' || role === '管理员' ? 'admin' : 'member';
}

export function InviteDialog({
  open,
  onClose,
  workspaceContext,
  freePlan = false,
  availableSeats,
  onUpgrade,
  onSubmit,
  canAssignRoles = true,
  entryFrom = 'workspace_switcher',
}: Props) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const analyticsPage = entryFrom === 'all_projects' ? 'all_projects' : 'home';
  const workspaceDimensions = workspaceAnalyticsDimensions(workspaceContext);
  const [rows, setRows] = useState<InviteRow[]>([{ email: '', role: DEFAULT_ROLE }]);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mock-only inline validation: bumped per send attempt (see InviteRowsEditor).
  // Declared with the other hooks, above the `!open` early return.
  const [submitCount, setSubmitCount] = useState(0);
  const autoCloseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open || canAssignRoles) return;
    setRows((prev) => prev.map((row) => ({ ...row, role: DEFAULT_ROLE })));
  }, [canAssignRoles, open]);

  useEffect(() => () => {
    if (autoCloseTimerRef.current === null) return;
    window.clearTimeout(autoCloseTimerRef.current);
    autoCloseTimerRef.current = null;
  }, [open]);

  // Reset the submit lifecycle each time the dialog opens so a prior error /
  // success never lingers on the next invite.
  useEffect(() => {
    if (!open) return;
    setSubmitting(false);
    setSuccess(false);
    setError(null);
    setSubmitCount(0);
    trackWorkspaceSurfaceView(analytics.track, {
      page_name: analyticsPage,
      area: 'workspace_invite_dialog',
      entry_from: entryFrom,
      ...workspaceDimensions,
    });
  }, [open, analytics.track, analyticsPage, entryFrom, workspaceDimensions.workspace_key]);

  if (!open) return null;

  function trackEditorEvent(element: InviteRowsEditorEvent) {
    trackWorkspaceInviteClick(analytics.track, {
      page_name: analyticsPage,
      area: 'workspace_invite_dialog',
      element,
      entry_from: entryFrom,
      ...workspaceDimensions,
    });
  }

  function closeDialog() {
    trackWorkspaceInviteClick(analytics.track, {
      page_name: analyticsPage,
      area: 'workspace_invite_dialog',
      element: 'close',
      entry_from: entryFrom,
      ...workspaceDimensions,
    });
    onClose();
  }

  // Demo-grade email shape check (something@something.tld) — keeps obvious
  // non-emails from enabling submit; both the button state and the rows
  // passed to onSubmit use the same predicate.
  const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  const hasValidEmail = rows.some((r) => isEmail(r.email));

  function inviteErrorMessage(code: string | undefined): string {
    return t(workspaceInviteErrorMessageKey(code));
  }

  // Seats are the gate B enforces anyway; checking here turns a post-send row
  // failure into an up-front reason the user can act on. Unknown (undefined)
  // stays permissive — see the prop docs.
  // DEV-ONLY review mock (`?mock=seatfree`): no seats, so nothing is ever full.
  const seatFreeMock = readSeatFreeMock();
  const seatsExhausted = !seatFreeMock && availableSeats !== undefined && availableSeats <= 0;

  async function handleConfirm() {
    if (seatFreeMock) {
      if (inviteRowsEmpty(rows) || success) return;
      setSubmitCount((count) => count + 1);
      if (inviteRowErrors(rows, SEAT_FREE_MEMBER_EMAILS).some(Boolean)) return;
      // Mock: pretend the batch went out; nothing reaches the daemon.
      setSuccess(true);
      autoCloseTimerRef.current = window.setTimeout(() => {
        autoCloseTimerRef.current = null;
        onClose();
        setRows([{ email: '', role: DEFAULT_ROLE }]);
        setSubmitCount(0);
        setSuccess(false);
      }, 1000);
      return;
    }
    const valid = rows.filter((r) => isEmail(r.email));
    if (valid.length === 0 || submitting || success || seatsExhausted) return;
    if (!workspaceContext) {
      setError(t('workspaceInvite.submitFailed'));
      return;
    }
    const requestContext = workspaceContext;
    const startedAt = performance.now();
    const requestId = analytics.newRequestId();
    trackWorkspaceInviteClick(analytics.track, {
      page_name: analyticsPage,
      area: 'workspace_invite_dialog',
      element: 'submit',
      entry_from: entryFrom,
      invite_count_bucket: countBucket(valid.length),
      ...workspaceDimensions,
    }, { requestId });
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace/invite', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...workspaceProjectHeaders(requestContext),
        },
        body: JSON.stringify({
          invites: valid.map((r) => ({ email: r.email.trim(), role: toCanonicalRole(r.role) })),
        }),
      });
      if (!res.ok) {
        trackWorkspaceInviteResult(analytics.track, {
          page_name: analyticsPage,
          area: 'workspace_invite_dialog',
          entry_from: entryFrom,
          result: 'failed',
          requested_count: valid.length,
          succeeded_count: 0,
          failed_count: valid.length,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: stableAnalyticsErrorCode(res.status),
          ...workspaceDimensions,
        }, { requestId });
        throw new Error('request_failed');
      }
      const body = (await res.json().catch(() => null)) as
        | { results?: Array<{ ok?: boolean; error?: string }> }
        | null;
      const results = body?.results ?? [];
      // Any failed row means the invite batch needs user attention; keep the
      // dialog open with a reason-specific message instead of a misleading
      // success state or a blanket "retry later".
      const failed = results.find((r) => r.ok === false);
      if (failed) {
        const failedCount = results.filter((r) => r.ok === false).length;
        const succeededCount = Math.max(valid.length - failedCount, 0);
        trackWorkspaceInviteResult(analytics.track, {
          page_name: analyticsPage,
          area: 'workspace_invite_dialog',
          entry_from: entryFrom,
          result: succeededCount > 0 ? 'partial_success' : 'failed',
          requested_count: valid.length,
          succeeded_count: succeededCount,
          failed_count: failedCount,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: normalizeWorkspaceInviteCreateErrorCode(failed.error) ?? 'invite_rejected',
          ...workspaceDimensions,
        }, { requestId });
        setError(inviteErrorMessage(failed.error));
        setSubmitting(false);
        return;
      }
      trackWorkspaceInviteResult(analytics.track, {
        page_name: analyticsPage,
        area: 'workspace_invite_dialog',
        entry_from: entryFrom,
        result: 'success',
        requested_count: valid.length,
        succeeded_count: valid.length,
        failed_count: 0,
        duration_ms: Math.round(performance.now() - startedAt),
        ...workspaceDimensions,
      }, { requestId });
      setSuccess(true);
      onSubmit?.(valid);
      autoCloseTimerRef.current = window.setTimeout(() => {
        autoCloseTimerRef.current = null;
        onClose();
        setRows([{ email: '', role: DEFAULT_ROLE }]);
        setSuccess(false);
        setSubmitting(false);
      }, 1000);
    } catch (caught) {
      if (caught instanceof TypeError) {
        trackWorkspaceInviteResult(analytics.track, {
          page_name: analyticsPage,
          area: 'workspace_invite_dialog',
          entry_from: entryFrom,
          result: 'failed',
          requested_count: valid.length,
          succeeded_count: 0,
          failed_count: valid.length,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: 'network_error',
          ...workspaceDimensions,
        }, { requestId });
      }
      setError(t('workspaceInvite.submitFailed'));
      setSubmitting(false);
    }
  }

  return (
    <div className="entry-invite" role="dialog" aria-modal="true" aria-label={t('workspaceInvite.dialogAria')}>
      <div className="entry-invite__backdrop" onClick={closeDialog} />
      <div className={`entry-invite__panel entry-invite__panel--split${seatFreeMock ? ' entry-invite__panel--seatfree' : ''}`}>
        <button
          type="button"
          className="entry-invite__close"
          onClick={closeDialog}
          aria-label={t('common.close')}
        >
          <Icon name="close" size={16} />
        </button>

        <div className="entry-invite__form">
          <h2 className="entry-invite__title">
            {seatFreeMock ? t('seatFree.inviteTitle') : t('workspaceInvite.title')}
          </h2>
          <p className="entry-invite__teamsize">
            {seatFreeMock
              ? t('seatFree.inviteBody')
              : seatsExhausted
              ? t('workspaceInvite.seatsExhaustedBody')
              : freePlan
                ? t('workspaceInvite.freePlanBody')
                : t('workspaceInvite.teamPlanBody')}
          </p>
          {seatsExhausted && onUpgrade ? (
            <Button variant="primary-ghost" onClick={() => {
              trackWorkspaceInviteClick(analytics.track, {
                page_name: analyticsPage,
                area: 'workspace_invite_dialog',
                element: 'upgrade',
                entry_from: entryFrom,
                ...workspaceDimensions,
              });
              onUpgrade();
            }}>
              {t('workspaceInvite.seatsExhaustedAction')}
            </Button>
          ) : null}

          <InviteRowsEditor
            rows={rows}
            onRowsChange={setRows}
            canAssignRoles={canAssignRoles}
            addRowAside={seatFreeMock ? <SeatFreeCopyInviteLink /> : null}
            validation={seatFreeMock ? { submitCount, memberEmails: SEAT_FREE_MEMBER_EMAILS } : undefined}
            describeRole={
              seatFreeMock
                ? (role) => t(role === 'admin' ? 'seatFree.roleDesc.admin' : 'seatFree.roleDesc.member')
                : undefined
            }
            onEvent={trackEditorEvent}
          />

          <button
            type="button"
            className="entry-invite__collapse"
            onClick={() => setVisibilityOpen((v) => !v)}
            aria-expanded={visibilityOpen}
          >
            {t('workspaceInvite.visibilityQuestion')}
            <Icon
              name="chevron-down"
              size={16}
              style={visibilityOpen ? { transform: 'rotate(180deg)' } : undefined}
            />
          </button>
          {visibilityOpen ? (
            <p className="entry-invite__collapse-body">
              {t('workspaceInvite.visibilityAnswer')}
            </p>
          ) : null}

          {error ? (
            <p className="entry-invite__collapse-body" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            className="entry-invite__submit"
            onClick={handleConfirm}
            disabled={
              (seatFreeMock ? inviteRowsEmpty(rows) : !hasValidEmail) || submitting || success || seatsExhausted
            }
          >
            {success
              ? t('workspaceInvite.sent')
              : submitting
                ? t('workspaceInvite.sending')
                : t('workspaceInvite.confirm')}
          </button>
        </div>

        <div className="entry-invite__art" aria-hidden>
          <span className="entry-invite__art-glow" />
          <div className="entry-invite__art-cluster">
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a2.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a1.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a4.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar">
              <img src="/team-avatars/a6.png" alt="" />
            </span>
            <span className="entry-invite__art-avatar entry-invite__art-avatar--invite">
              <Icon name="plus" size={26} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
