import { randomUUID } from 'node:crypto';
import type { ProjectPreviewScopeDeps, ProjectPreviewScopeOptions } from '../server-context.js';

const PROJECT_PREVIEW_SCOPE_TTL_MS = 60 * 60 * 1000;
type Workspace = { workspaceId: string; workspaceMemberId: string } | null;
interface ScopeEntry {
  projectId: string;
  workspace: Workspace;
  reusable: boolean;
  expiresAt: number;
  documentExpiresAt: number;
  entryFile: string | undefined;
  bridges: readonly string[];
  documentMode: NonNullable<ProjectPreviewScopeOptions['documentMode']>;
}

/**
 * A live preview owns a stable capability for one HTML entry and bridge set.
 * Directory navigation may return only that bound entry. One-shot export
 * capabilities are never adopted by live previews; renewal never changes the
 * expiry embedded in a document, keeping refetches byte-identical.
 */
export function createProjectPreviewScopeRegistry(): ProjectPreviewScopeDeps {
  const scopes = new Map<string, ScopeEntry>();
  function get(projectId: string, scope: string): ScopeEntry | undefined {
    const key = String(scope || '');
    const entry = scopes.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      scopes.delete(key);
      return undefined;
    }
    return entry.projectId === String(projectId) ? entry : undefined;
  }
  function create(projectId: string, workspace: Workspace, options: ProjectPreviewScopeOptions, reusable: boolean): string {
    for (const [scope, entry] of scopes) {
      if (entry.expiresAt <= Date.now()) scopes.delete(scope);
    }
    const scope = randomUUID();
    const expiresAt = Date.now() + (options.ttlMs ?? PROJECT_PREVIEW_SCOPE_TTL_MS);
    scopes.set(scope, {
      projectId: String(projectId), workspace, reusable, expiresAt,
      documentExpiresAt: expiresAt,
      entryFile: options.entryFile,
      documentMode: options.documentMode ?? 'resource',
      bridges: [...new Set(options.bridges ?? [])].sort(),
    });
    return scope;
  }
  return {
    mint(projectId, workspace = null, options = {}) {
      return create(projectId, workspace, options, false);
    },
    acquire(projectId, workspace = null, options = {}) {
      const bridges = [...new Set(options.bridges ?? [])].sort();
      for (const [scope, candidate] of scopes) {
        const entry = get(projectId, scope);
        if (!entry || !candidate.reusable) continue;
        if (entry.workspace?.workspaceId !== workspace?.workspaceId
          || entry.workspace?.workspaceMemberId !== workspace?.workspaceMemberId) continue;
        if (entry.entryFile !== options.entryFile) continue;
        if (entry.documentMode !== (options.documentMode ?? 'resource')) continue;
        if (JSON.stringify(entry.bridges) !== JSON.stringify(bridges)) continue;
        return scope;
      }
      return create(projectId, workspace, options, true);
    },
    revoke(scope) { scopes.delete(String(scope || '')); },
    documentExpiresAt(projectId, scope) { return get(projectId, scope)?.documentExpiresAt; },
    expiresAt(projectId, scope) { return get(projectId, scope)?.expiresAt; },
    renew(projectId, scope, options = {}) {
      const entry = get(projectId, scope);
      if (!entry) return undefined;
      entry.expiresAt = Date.now() + (options.ttlMs ?? PROJECT_PREVIEW_SCOPE_TTL_MS);
      return entry.expiresAt;
    },
    validate(projectId, scope) { return get(projectId, scope) !== undefined; },
    resolve(projectId, scope) { return get(projectId, scope)?.workspace; },
    document(projectId, scope) {
      const entry = get(projectId, scope);
      return entry?.entryFile ? { entryFile: entry.entryFile, bridges: entry.bridges, documentMode: entry.documentMode } : undefined;
    },
  };
}
