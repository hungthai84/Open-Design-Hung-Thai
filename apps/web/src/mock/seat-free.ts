// DEV-ONLY mock switch for the "一期：无限邀请、共享额度、套餐统一" review mock.
//
// Nothing here talks to the daemon or B. When the switch is OFF (the default)
// every helper returns null / passes its input through, so production behavior
// is unchanged. Turn it on from the address bar:
//
//   ?mock=seatfree&role=owner|admin|member&plan=free|pro&quota=10|20|100|200
//     &balance=0&members=8&onboard=invite&gate=1&invite=1
//
// The parameters persist in localStorage so in-app navigation keeps the mock;
// `?mock=off` clears it.

import type { WorkspaceCollabContext } from '@open-design/contracts';

export type SeatFreeRole = 'owner' | 'admin' | 'member';
export type SeatFreePlan = 'free' | 'pro';
export const SEAT_FREE_QUOTAS = [10, 20, 100, 200] as const;
export type SeatFreeQuota = (typeof SEAT_FREE_QUOTAS)[number];
/** Monthly credits each Pro tier grants ($100 and $200 include a bonus). */
export const SEAT_FREE_TIER_CREDITS: Record<SeatFreeQuota, number> = {
  10: 10,
  20: 20,
  100: 120,
  200: 300,
};
/** One-off free credits granted at sign-up. */
export const SEAT_FREE_SIGNUP_GRANT_USD = 0.5;

export interface SeatFreeMockState {
  role: SeatFreeRole;
  plan: SeatFreePlan;
  /** Pro monthly credit tier, priced like today's Go / Plus / Pro / Max. */
  quotaUsd: SeatFreeQuota;
  /** Remaining shared workspace credits (USD). */
  balanceUsd: number;
  memberCount: number;
  workspaceName: string;
  ownerName: string;
  /** Signed-in account (`account=`); per-account UI memory keys off it. */
  accountId: string;
  /** Jump onboarding straight to the "invite teammates" step. */
  onboardInvite: boolean;
  /** Open the out-of-credits dialog on load (`gate=1` or `gate=midrun`). */
  gate: boolean;
  /** `gate=midrun`: a running task was stopped because credits ran out. */
  midrun: boolean;
  /** Open the invite dialog on Home. */
  invite: boolean;
  /**
   * How the onboarding invite send turns out (`send=`): `ok` (default),
   * `fail` (nothing went out, e.g. network; a retry succeeds) or `partial`
   * (the last address already holds a pending invite, the rest go out).
   */
  sendResult: 'ok' | 'fail' | 'partial';
}

const STORAGE_KEY = 'od.mock.seatfree';

function readParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URLSearchParams(window.location.search);
    const flag = url.get('mock');
    if (flag === 'off') {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (flag === 'seatfree') {
      window.localStorage.setItem(STORAGE_KEY, url.toString());
      return url;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? new URLSearchParams(stored) : null;
  } catch {
    return null;
  }
}

let cached: { key: string; state: SeatFreeMockState | null } | null = null;

export function readSeatFreeMock(): SeatFreeMockState | null {
  const params = readParams();
  const key = params?.toString() ?? '';
  if (cached && cached.key === key) return cached.state;
  let state: SeatFreeMockState | null = null;
  if (params) {
    const role = params.get('role');
    const plan = params.get('plan') === 'free' ? 'free' : 'pro';
    const quotaRaw = Number(params.get('quota') ?? 20);
    const quotaUsd = (SEAT_FREE_QUOTAS as readonly number[]).includes(quotaRaw)
      ? (quotaRaw as SeatFreeQuota)
      : 20;
    const balanceRaw = Number(params.get('balance') ?? (plan === 'free' ? 0.3 : 12.4));
    const membersRaw = Number(params.get('members') ?? 8);
    state = {
      role: role === 'admin' || role === 'member' ? role : 'owner',
      plan,
      quotaUsd,
      balanceUsd: Number.isFinite(balanceRaw) ? Math.max(0, balanceRaw) : 0,
      memberCount: Number.isFinite(membersRaw) && membersRaw > 0 ? Math.round(membersRaw) : 8,
      workspaceName: params.get('ws') || 'Acme Design',
      ownerName: params.get('owner') || 'Lin Zhou',
      accountId: params.get('account') || 'lin@acme.com',
      onboardInvite: params.get('onboard') === 'invite',
      gate: params.get('gate') === '1' || params.get('gate') === 'midrun',
      midrun: params.get('gate') === 'midrun',
      invite: params.get('invite') === '1',
      sendResult:
        params.get('send') === 'fail' ? 'fail' : params.get('send') === 'partial' ? 'partial' : 'ok',
    };
  }
  cached = { key, state };
  return state;
}

export function isSeatFreeMock(): boolean {
  return readSeatFreeMock() !== null;
}

export function formatMockUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

let mockContext: { key: string; context: WorkspaceCollabContext } | null = null;

/**
 * A fake, stable workspace context for the mock. Every account owns one
 * workspace, so the mock context is always team-shaped (members can be
 * invited) and carries no seat accounting.
 */
export function seatFreeMockContext(state: SeatFreeMockState): WorkspaceCollabContext {
  const key = `${state.role}:${state.plan}:${state.workspaceName}`;
  if (mockContext && mockContext.key === key) return mockContext.context;
  const isOwner = state.role === 'owner';
  const canManage = state.role !== 'member';
  const context: WorkspaceCollabContext = {
    // Distinct per `ws=` so switching the mocked workspace is a real switch.
    workspaceId: `mock-ws-${state.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    workspaceType: 'team',
    workspaceMemberId: `mock-member-${state.role}`,
    role: state.role,
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: state.plan === 'free' ? 'free' : 'active',
    planId: state.plan === 'free' ? null : 'pro',
    providerMode: 'platform_credits',
    // No seats any more: an "unknown capacity" summary keeps every seat gate open.
    seatSummary: { seatLimit: 0, usedSeats: 0, availableSeats: 0, isSeatFull: false },
    permissions: {
      canManageMembers: canManage,
      canManageBilling: isOwner,
      canInviteMembers: true,
      canManageAutoRecharge: isOwner,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: canManage,
      canManageSharedResources: canManage,
    },
    teamId: 'mock-team-seatfree',
    teamName: state.workspaceName,
    workspaceName: state.workspaceName,
    displayName: state.role === 'owner' ? state.ownerName : 'Sam Lee',
  };
  mockContext = { key, context };
  return context;
}

/** Collapse any legacy tier word to the two remaining plans. */
export function seatFreePlanFromTier(tier: string | null | undefined): SeatFreePlan {
  const normalized = (tier ?? '').trim().toLowerCase();
  if (!normalized || normalized.includes('free') || normalized.includes('免费')) return 'free';
  return 'pro';
}

// Keyed by ACCOUNT only: closing the banner once hides it in every workspace
// that account opens.
const bannerDismissedKey = (accountId: string) =>
  `od.mock.seatfree.inviteBannerDismissed:${accountId}`;

/**
 * Whether the one-member invite banner was dismissed. `?banner=reset` clears
 * the remembered dismissal so the banner can be reviewed again.
 */
export function seatFreeInviteBannerDismissed(accountId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('banner') === 'reset') {
      window.localStorage.removeItem(bannerDismissedKey(accountId));
      return false;
    }
    return window.localStorage.getItem(bannerDismissedKey(accountId)) === '1';
  } catch {
    return false;
  }
}

export function dismissSeatFreeInviteBanner(accountId: string): void {
  try {
    window.localStorage.setItem(bannerDismissedKey(accountId), '1');
  } catch {
    // Storage blocked: the banner simply comes back next load.
  }
}

export function openSeatFreeInvite(): void {
  window.dispatchEvent(new Event(SEAT_FREE_OPEN_INVITE_EVENT));
}

/**
 * The web console's seat-free mock (vela `?mock=seatfree`, local dev port).
 * The mock context carries no console URL, so entries that link out to the
 * console (新建团队) fall back to this one.
 */
export const SEAT_FREE_CONSOLE_URL = 'http://localhost:5191/settings?mock=seatfree';

/**
 * The workspace's shareable join link, served by the web console mock (same
 * code as vela's seat-free members page). Valid 7 days; joins as Member.
 */
// Emails already in the mock workspace, so the invite form can show the
// "already in the team" error. lin@acme.com is the default owner account.
export const SEAT_FREE_MEMBER_EMAILS: readonly string[] = ['lin@acme.com', 'mia@acme.com', 'kai@acme.com'];
// Onboarding → home handoff: how many invites the last onboarding step sent,
// so home can confirm it once in a toast. Cleared when that toast goes away.
let pendingInvitesSent: number | null = null;
export function noteSeatFreeInvitesSent(count: number): void {
  pendingInvitesSent = count > 0 ? count : null;
  // They just invited people: the "invite teammates" banner would only repeat
  // the ask. `?banner=reset` brings it back for review.
  const accountId = readSeatFreeMock()?.accountId;
  if (pendingInvitesSent && accountId) dismissSeatFreeInviteBanner(accountId);
}
export function peekSeatFreeInvitesSent(): number | null {
  return pendingInvitesSent;
}
export function clearSeatFreeInvitesSent(): void {
  pendingInvitesSent = null;
}

export const SEAT_FREE_INVITE_LINK = 'http://localhost:5191/join/acme-design-7Kq2xP?mock=seatfree';

/** Window event Home fires to open the rail's invite dialog (mock only). */
export const SEAT_FREE_OPEN_INVITE_EVENT = 'open-design:seatfree-open-invite';
