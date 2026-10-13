// DEV-ONLY review mock (`?mock=seatfree`): the closing onboarding step,
// "invite teammates". Same cloud onboarding layout (pane + art) as the steps
// before it: title, one line on why (free, shared credits, collaboration), the invite dialog's recipient rows
// (email + role, one to start, more on demand) with the primary action, then
// "or" and a separate invite-by-link card, and a quiet skip. Sends nothing;
// `send=fail|partial` plays back the failure paths (see SeatFreeMockState).

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { useCopyInviteLink } from './SeatFreeCopyInviteLink';
import {
  DEFAULT_INVITE_ROLE,
  InviteRowsEditor,
  inviteRowErrors,
  inviteRowsEmpty,
  type InviteRow,
  type InviteRowError,
} from './InviteRowsEditor';
import {
  noteSeatFreeInvitesSent,
  readSeatFreeMock,
  SEAT_FREE_MEMBER_EMAILS,
} from '../mock/seat-free';
import { LanguageMenu } from './LanguageMenu';
import styles from './SeatFreeOnboardingInvite.module.css';

const INITIAL_ROWS = 1;
// How long "✓ Invited N teammates" stays up before onboarding hands off to home.
const SENT_HOLD_MS = 1000;
// Fake round trip, so "sending…" shows before the result.
const SEND_MS = 700;
// After a partial send, how long "✓ Invited N" stays before the button is
// "send" again for the rows that are left.
const PARTIAL_HOLD_MS = 1600;

export function SeatFreeOnboardingInvite({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<InviteRow[]>(() =>
    Array.from({ length: INITIAL_ROWS }, () => ({ email: '', role: DEFAULT_INVITE_ROLE })),
  );
  const [sending, setSending] = useState(false);
  // "✓ Invited N" on the button; null when it reads "send".
  const [sentCount, setSentCount] = useState<number | null>(null);
  // Invites that went out so far (a partial send keeps the user here).
  const totalSentRef = useRef(0);
  // Whole-batch failure (network / server): one line under the button.
  const [sendFailed, setSendFailed] = useState(false);
  const [sendErrors, setSendErrors] = useState<Record<string, InviteRowError>>({});
  const [submitCount, setSubmitCount] = useState(0);
  const timerRef = useRef<number | null>(null);
  const failedOnceRef = useRef(false);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  function later(ms: number, fn: () => void) {
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      fn();
    }, ms);
  }

  function finish() {
    if (totalSentRef.current > 0) noteSeatFreeInvitesSent(totalSentRef.current);
    onDone();
  }

  // All sent: confirm on the button for a beat, then move on to home by
  // itself (home confirms again in a toast). Nothing sent: stay, say so under
  // the button, keep every row. Some sent: drop those rows, mark the rest
  // with their reason, and stay so the user can fix them or skip.
  function send() {
    if (sending || sentCount !== null) return;
    // Every attempt re-reveals errors and focuses the first bad row.
    setSubmitCount((count) => count + 1);
    if (inviteRowErrors(rows, SEAT_FREE_MEMBER_EMAILS).some(Boolean)) return;
    const filled = rows.filter((row) => row.email.trim());
    const key = (row: InviteRow) => row.email.trim().toLowerCase();
    if (filled.some((row) => sendErrors[key(row)])) return;
    setSendFailed(false);
    setSending(true);
    later(SEND_MS, () => {
      setSending(false);
      const mode = readSeatFreeMock()?.sendResult ?? 'ok';
      // The network failure is a one-off: the retry goes through.
      if (mode === 'fail' && !failedOnceRef.current) {
        failedOnceRef.current = true;
        setSendFailed(true);
        return;
      }
      const rejected = mode === 'partial' ? filled.slice(-1) : [];
      const okCount = filled.length - rejected.length;
      totalSentRef.current += okCount;
      if (rejected.length === 0) {
        setSentCount(okCount);
        later(SENT_HOLD_MS, finish);
        return;
      }
      setSendErrors((prev) => ({
        ...prev,
        ...Object.fromEntries(rejected.map((row) => [key(row), 'pending' as const])),
      }));
      setRows(rejected);
      setSubmitCount((count) => count + 1);
      if (okCount === 0) return;
      setSentCount(okCount);
      later(PARTIAL_HOLD_MS, () => setSentCount(null));
    });
  }
  const sent = sentCount !== null;
  const title = t('seatFree.onboardInviteTitle');
  const { copied, copy } = useCopyInviteLink();

  return (
    <section
      className={`onboarding-view onboarding-view--cloud ${styles.view}`}
      aria-label={title}
      data-testid="seatfree-onboarding-invite"
    >
      <div className="onboarding-cloud__pane">
        <div className="onboarding-cloud__center">
          <h1 className="onboarding-cloud__title">{title}</h1>
          <p className="onboarding-cloud__body">{t('seatFree.onboardInviteBody')}</p>
          <div className={styles.form}>
            <InviteRowsEditor
              rows={rows}
              onRowsChange={(next) => {
                setRows(next);
                setSendFailed(false);
              }}
              validation={{ submitCount, memberEmails: SEAT_FREE_MEMBER_EMAILS, sendErrors }}
              describeRole={(role) =>
                t(role === 'admin' ? 'seatFree.roleDesc.admin' : 'seatFree.roleDesc.member')
              }
            />
            <button
              type="button"
              className="onboarding-cloud__primary"
              // Stays enabled (dark) while showing "Invited N": a greyed-out
              // button would read as a failure. send() ignores repeat clicks.
              disabled={inviteRowsEmpty(rows)}
              aria-disabled={sent || sending || undefined}
              aria-busy={sending || undefined}
              onClick={send}
            >
              {sent ? <Icon name="check" size={17} /> : null}
              <span>
                {sent
                  ? t('seatFree.invitedCount', { count: sentCount })
                  : sending
                    ? t('seatFree.sending')
                    : t('seatFree.sendInvites')}
              </span>
            </button>
            {sendFailed ? (
              <p className={styles.sendError} role="alert">
                {t('seatFree.sendFailed')}
              </p>
            ) : null}
            <div className={styles.or} aria-hidden="true">
              <span>{t('seatFree.onboardOr')}</span>
            </div>
            <div className={styles.linkCard}>
              <span className={styles.linkIcon}>
                <Icon name="link" size={16} />
              </span>
              <div className={styles.linkText}>
                <span className={styles.linkTitle}>{t('seatFree.linkInviteTitle')}</span>
                <span className={styles.linkHint}>{t('seatFree.linkInviteHint')}</span>
              </div>
              <button
                type="button"
                className={`${styles.linkCopy}${copied ? ` ${styles.linkCopied}` : ''}`}
                onClick={() => void copy()}
                data-testid="seatfree-copy-invite-link"
              >
                <Icon name={copied ? 'check' : 'copy'} size={14} />
                <span>{copied ? t('seatFree.linkCopied') : t('seatFree.copyLink')}</span>
              </button>
            </div>
          </div>
          <button type="button" className="onboarding-cloud__cancel" onClick={finish}>
            {t('seatFree.skip')}
          </button>
        </div>
        <footer className="onboarding-cloud__footer">
          <LanguageMenu placement="up" align="start" />
          <span>© {new Date().getFullYear()} OpenDesign · {t('settings.onboardingCloudRights')}</span>
        </footer>
      </div>
      <div className="onboarding-cloud__art" aria-hidden="true">
        <img src="/onboarding/onboarding-cloud-art.webp" alt="" />
      </div>
    </section>
  );
}
