// DEV-ONLY review mock (`?mock=seatfree`): the home-side half of the
// onboarding invite step. After "send invites" onboarding moves on to home by
// itself; this confirms once how many invites went out, then clears.

import { useState } from 'react';
import { useT } from '../i18n';
import { clearSeatFreeInvitesSent, peekSeatFreeInvitesSent } from '../mock/seat-free';
import { Toast } from './Toast';

export function SeatFreeInvitesSentToast() {
  const t = useT();
  // Peek (not take) on mount so a StrictMode double render still sees it;
  // the handoff is cleared when the toast goes away.
  const [count, setCount] = useState(() => peekSeatFreeInvitesSent());
  if (count === null) return null;
  return (
    <Toast
      message={t('seatFree.invitesSentToast', { count })}
      tone="success"
      placement="top"
      ttlMs={5000}
      portalToBody
      onDismiss={() => {
        clearSeatFreeInvitesSent();
        setCount(null);
      }}
    />
  );
}
