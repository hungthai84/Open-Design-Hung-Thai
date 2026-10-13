// DEV-ONLY review mock (`?mock=seatfree`): "copy invite link" beside the invite
// rows. Anyone can copy it; the link is valid 7 days and joins as Member (same
// rules and link as the web console's members page). After a copy the button
// confirms for a moment and the validity note appears under it.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { SEAT_FREE_INVITE_LINK } from '../mock/seat-free';
import { Icon } from './Icon';
import styles from './SeatFreeCopyInviteLink.module.css';

const COPIED_MS = 2400;

/** Copies the mock invite link; `copied` stays true for a moment after. */
export function useCopyInviteLink() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(SEAT_FREE_INVITE_LINK);
    } catch {
      // Clipboard may be blocked (insecure origin, preview); still confirm so
      // the review flow reads the same.
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, COPIED_MS);
  }

  return { copied, copy };
}

export function SeatFreeCopyInviteLink() {
  const t = useT();
  const { copied, copy } = useCopyInviteLink();

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.copy}${copied ? ` ${styles.copied}` : ''}`}
        onClick={() => void copy()}
        title={t('seatFree.inviteLinkValidity')}
        data-testid="seatfree-copy-invite-link"
      >
        <Icon name={copied ? 'check' : 'link'} size={14} />
        <span>{copied ? t('seatFree.inviteLinkCopied') : t('seatFree.copyInviteLink')}</span>
      </button>
      <span className={`${styles.note}${copied ? ` ${styles.noteVisible}` : ''}`} role="status">
        {copied ? t('seatFree.inviteLinkValidity') : ''}
      </span>
    </div>
  );
}
