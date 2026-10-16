import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectPreviewScopeRegistry } from '../../src/services/project-preview-scopes.js';

afterEach(() => vi.useRealTimers());

describe('project preview scope ownership', () => {
  it('reuses only the same document, Workspace and bridge policy without changing document expiry', () => {
    vi.useFakeTimers();
    const registry = createProjectPreviewScopeRegistry();
    const workspace = { workspaceId: 'workspace', workspaceMemberId: 'member' };
    const options = { entryFile: 'screens/board.html', bridges: ['scroll', 'sandbox'], ttlMs: 1_000 };
    const first = registry.acquire('project', workspace, options);
    const documentExpiry = registry.documentExpiresAt('project', first);
    vi.advanceTimersByTime(500);
    registry.renew('project', first, { ttlMs: 1_000 });
    expect(registry.acquire('project', workspace, { ...options, bridges: ['sandbox', 'scroll'] })).toBe(first);
    expect(registry.documentExpiresAt('project', first)).toBe(documentExpiry);
    expect(registry.expiresAt('project', first)).toBe(documentExpiry! + 500);
    expect(registry.acquire('project', workspace, { ...options, entryFile: 'screens/index.html' })).not.toBe(first);
    expect(registry.acquire('project', workspace, { ...options, bridges: ['scroll'] })).not.toBe(first);
    for (const documentMode of ['url', 'bootstrap', 'bootstrap-quirks'] as const) {
      expect(registry.acquire('project', workspace, { ...options, documentMode })).not.toBe(first);
    }
    expect(registry.acquire('project', { ...workspace, workspaceMemberId: 'other' }, options)).not.toBe(first);
    expect(registry.document('project', first)?.entryFile).toBe('screens/board.html');
    expect(registry.document('other-project', first)).toBeUndefined();
  });

  it('never adopts a one-shot export scope, and rejects expiry and revocation', () => {
    vi.useFakeTimers();
    const registry = createProjectPreviewScopeRegistry();
    const options = { entryFile: 'index.html', ttlMs: 1_000 };
    const exported = registry.mint('project', null, options);
    const live = registry.acquire('project', null, options);
    expect(live).not.toBe(exported);
    registry.revoke(exported);
    expect(registry.validate('project', live)).toBe(true);
    expect(registry.validate('project', exported)).toBe(false);
    vi.advanceTimersByTime(999);
    expect(registry.document('project', live)?.entryFile).toBe('index.html');
    vi.advanceTimersByTime(1);
    expect(registry.document('project', live)).toBeUndefined();
    expect(registry.resolve('project', live)).toBeUndefined();
    expect(registry.renew('project', live)).toBeUndefined();
    expect(registry.validate('project', live)).toBe(false);
  });
});
