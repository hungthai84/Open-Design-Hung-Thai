import type { WorkspaceBillingResponse, WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceBillingBalanceUsd, workspaceBillingSnapshotForContext } from './useWorkspaceContext';

export type WorkspaceQuotaTier = 'free' | 'go' | 'plus' | 'pro' | 'max';

/** Presentation values, not a new daemon/CLI wire contract. */
export interface WorkspaceQuotaView {
  tier: WorkspaceQuotaTier | null;
  planKnown: boolean;
  loading: boolean;
  balanceUsd: string | null;
  /** Only a server status may populate this; never dates. */
  planStatus: string | null;
  windows: ReadonlyArray<{
    durationSeconds: number;
    remainingPercent: number;
    resetsAt: string | null;
  }> | null;
  breakdown: string | null;
  modelRestriction: string | null;
}

const DESIGN_PLAN_WINDOWS_FIELD = 'designPlanWindows';

type WorkspaceQuotaWindow = NonNullable<WorkspaceQuotaView['windows']>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map the additive server field only when every window is well-formed. */
export function workspaceDesignPlanWindows(snapshot: unknown): WorkspaceQuotaView['windows'] {
  if (!isRecord(snapshot)) return null;
  const rawWindows = snapshot[DESIGN_PLAN_WINDOWS_FIELD];
  if (!Array.isArray(rawWindows) || rawWindows.length === 0) return null;

  const seenKinds = new Set<string>();
  const windows: WorkspaceQuotaWindow[] = [];
  for (const rawWindow of rawWindows) {
    if (!isRecord(rawWindow)) return null;
    const { kind, remainingCredits, limitCredits, resetsAt } = rawWindow;
    const windowStart = rawWindow.windowStart;
    if (
      (kind !== '5h' && kind !== '7d')
      || seenKinds.has(kind)
      || typeof remainingCredits !== 'string'
      || !/^(0|[1-9]\d*)$/.test(remainingCredits)
      || typeof limitCredits !== 'string'
      || !/^(0|[1-9]\d*)$/.test(limitCredits)
      || limitCredits === '0'
      || (resetsAt !== null && typeof resetsAt !== 'string')
      || (windowStart !== null && typeof windowStart !== 'string')
    ) {
      return null;
    }

    const remaining = BigInt(remainingCredits);
    const limit = BigInt(limitCredits);
    if (remaining > limit) return null;
    seenKinds.add(kind);

    const used = limit - remaining;
    const basisPoints = Number((used * 10_000n) / limit);
    const usedPercent = Math.min(100, Math.max(0, Math.round(basisPoints / 100)));
    windows.push({
      durationSeconds: kind === '5h' ? 18_000 : 604_800,
      remainingPercent: 100 - usedPercent,
      resetsAt: typeof resetsAt === 'string' && resetsAt ? resetsAt : null,
    });
  }

  return windows.sort((left, right) => left.durationSeconds - right.durationSeconds);
}

export function workspaceQuotaTier(raw: string | null | undefined): WorkspaceQuotaTier | null {
  const parts = raw?.trim().toLowerCase().split(/[_-]+/) ?? [];
  return (['free', 'go', 'plus', 'pro', 'max'] as const).find(tier => parts.includes(tier)) ?? null;
}

export function workspaceQuotaView({ context, response, tier, balanceUsd }: {
  context: WorkspaceCollabContext | null;
  response?: WorkspaceBillingResponse | null;
  tier: string | null;
  /** Existing host's explicitly workspace-scoped money, for callers without a raw response. */
  balanceUsd?: string | null;
}): WorkspaceQuotaView {
  // A raw response must prove this workspace AND member.
  // Never fall through to the host's older amount after a scoped read rejects it.
  const balance = context?.workspaceId && context.workspaceMemberId
    ? response !== undefined
      ? workspaceBillingBalanceUsd(response, context)
      : balanceUsd ?? null
    : null;
  // The host's account advisory tier must not rename
  // this workspace. Prefer the proven v1 snapshot, then its current context.
  // Retain the host's scoped tier hint while the raw read is still pending.
  const snapshot = workspaceBillingSnapshotForContext(response, context);
  const snapshotTier = snapshot?.billing.planId?.trim()
    || (snapshot?.billing.billingState === 'free' ? 'free' : null);
  const scopedTier = snapshotTier || context?.planId?.trim()
    || (context?.billingState === 'free' ? 'free' : null)
    || (response == null ? tier : null);
  return {
    tier: workspaceQuotaTier(scopedTier),
    planKnown: Boolean(scopedTier?.trim()),
    loading: balance == null && !response?.workspaceBalance && !response?.workspaceSnapshot,
    balanceUsd: balance,
    // Account summary / personal Coding Plan are not substitutes for workspace data.
    planStatus: null,
    windows: workspaceDesignPlanWindows(snapshot),
    breakdown: null,
    modelRestriction: null,
  };
}
