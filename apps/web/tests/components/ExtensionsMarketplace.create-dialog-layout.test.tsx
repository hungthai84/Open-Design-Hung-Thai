// @vitest-environment jsdom
//
// Acceptance #110 — the 新增 (import) dialog's action buttons rendered
// dangling at the bottom-left OUTSIDE their cards. Each card `<article>` is a
// two-column grid (`minmax(0, 1fr) auto`); the 导入并上传 / 上传 buttons were
// direct <article> children, so they wrapped into the grid's second row
// instead of sitting inside the card content. These specs pin the structure:
// every action button must live inside the card's content column.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ExtensionsMarketplace } from '../../src/components/PluginsView';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

// Spread the real module — see the note in ExtensionsMarketplace.team-scope.test.tsx.
vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>()),
  useWorkspaceContext: () => ({ context: null, loading: false, refresh: vi.fn() }),
  useWorkspaceBilling: () => null,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/skills') return jsonResponse({ skills: [] });
    if (url.startsWith('/api/plugins')) return jsonResponse({ plugins: [] });
    if (url.startsWith('/api/marketplaces')) return jsonResponse({ marketplaces: [] });
    if (url.includes('/api/workspace/')) return jsonResponse({ ids: [], resources: [] });
    return jsonResponse({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openCreateDialog() {
  const view = render(
    <I18nProvider initial="en">
      <ExtensionsMarketplace onCreatePlugin={vi.fn()} onUsePlugin={vi.fn()} />
    </I18nProvider>,
  );
  fireEvent.click(view.container.querySelector('.plugin-marketplace__create')!);
  await waitFor(() => {
    expect(view.container.querySelector('.plugin-marketplace__create-panel')).not.toBeNull();
  });
  return view;
}

describe('ExtensionsMarketplace create dialog layout (#110)', () => {
  it('keeps every card action button inside the card content, never a direct <article> child', async () => {
    const { container } = await openCreateDialog();

    const articles = [
      ...container.querySelectorAll('.plugin-marketplace__create-options article'),
    ];
    expect(articles.length).toBeGreaterThan(0);
    for (const article of articles) {
      const strayButtons = [...article.children].filter(
        (child) => child.tagName === 'BUTTON',
      );
      expect(strayButtons).toEqual([]);
    }
  });

  it('renders 导入并上传 beside the URL input in the card content, not as a direct article child', async () => {
    await openCreateDialog();

    const importButton = screen.getByTestId('plugin-create-import-url');
    // #5517-aligned shape: input and button share one row (matches the
    // demo's `url-import-row`), not a labelled block with the button
    // stacked below it.
    const row = importButton.closest('.plugin-marketplace__url-import-row');
    expect(row).not.toBeNull();
    expect(row!.querySelector('input')).not.toBeNull();
    // That row still lives inside the card's content column — not the
    // article grid directly (issue #110).
    const contentColumn = row!.parentElement!;
    expect(contentColumn.tagName).toBe('DIV');
    expect(contentColumn.querySelector('h3')).not.toBeNull();
  });

  it('renders the upload action beside the folder picker inside the folder card row', async () => {
    await openCreateDialog();

    const uploadButton = screen.getByTestId('plugin-create-upload-folder');
    const row = uploadButton.closest('.plugin-marketplace__folder-action-row');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.plugin-marketplace__folder-pick')).not.toBeNull();
    // The row itself sits in the card's content column.
    expect(row!.closest('article')).not.toBeNull();
  });

  it('imports a parent folder of skills through the batch endpoint and lists per-skill outcomes (#8753)', async () => {
    const innerFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/skills/import-batch') {
        return jsonResponse({
          results: [
            { name: 'alpha-skill', status: 'imported', id: 'alpha-skill' },
            { name: 'dupeskill', status: 'skipped', code: 'CONFLICT', error: 'already exists' },
          ],
        });
      }
      return innerFetch(input, init);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = await openCreateDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Skill' }));

    const skillFile = (relativePath: string, content: string) => {
      const file = new File([content], 'SKILL.md', { type: 'text/markdown' });
      Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
      return file;
    };
    const files = [
      skillFile('my-skills/alpha/SKILL.md', '---\nname: alpha-skill\n---\n\n# Alpha\n'),
      skillFile('my-skills/beta/SKILL.md', '---\nname: dupeskill\n---\n\n# Beta\n'),
    ];
    const folderInput = container.querySelector('input[webkitdirectory]');
    expect(folderInput).not.toBeNull();
    fireEvent.change(folderInput!, { target: { files } });
    fireEvent.click(screen.getByTestId('plugin-create-upload-folder'));

    const results = await screen.findByTestId('skill-batch-results');
    expect(results.textContent).toContain('alpha-skill');
    expect(results.textContent).toContain('Imported');
    expect(results.textContent).toContain('dupeskill');
    expect(results.textContent).toContain('Skipped');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skills/import-batch',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
