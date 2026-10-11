import { useT } from '../i18n';
import { formatMockUsd, readSeatFreeMock } from '../mock/seat-free';

export type PlanBadgeSize = 'sm' | 'md';

/**
 * The OpenDesign plan nameplate — one source of truth for the
 * free / plus / pro / max tier pill so Settings, the model switcher, and the
 * avatar menu all render the same shape. `plan` is the raw tier string (e.g.
 * "plus" or "Plus"); the label capitalizes via CSS. Color follows the active
 * brand theme. Renders nothing for an empty plan so callers can pass through an
 * unresolved value directly. Styles live in the global `styles/plan-badge.css`
 * (intentionally not a CSS Module — see that file for why).
 */
export function PlanBadge({
  plan,
  size = 'md',
  className,
  title,
}: {
  plan: string | null | undefined;
  size?: PlanBadgeSize;
  className?: string;
  title?: string;
}) {
  const t = useT();
  const raw = plan?.trim();
  if (!raw) return null;
  // DEV-ONLY review mock (`?mock=seatfree`): only two plans remain — Free and
  // a single Pro (shown with its chosen monthly credit tier).
  const mock = readSeatFreeMock();
  const label = mock
    ? mock.plan === 'free'
      ? t('seatFree.planFree')
      : `${t('seatFree.planPro')} · ${t('seatFree.perMonth', { amount: formatMockUsd(mock.quotaUsd).replace('.00', '') })}`
    : raw;
  const dataPlan = mock ? mock.plan : raw.toLowerCase();
  return (
    <span
      className={['plan-badge', `plan-badge--${size}`, className]
        .filter(Boolean)
        .join(' ')}
      data-plan={dataPlan}
      title={title}
      // Mock labels carry their own casing (`$20/mo` must not become `/Mo`).
      style={mock ? { textTransform: 'none' } : undefined}
    >
      {label}
    </span>
  );
}
