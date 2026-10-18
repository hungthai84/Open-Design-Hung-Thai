import { describe, expect, it } from 'vitest';

import {
  canAutoRenameProjectFromPrompt,
  displayProjectName,
  SHARED_PROJECT_PLACEHOLDER_NAME,
  summarizeProjectNameFromPrompt,
} from '../../src/utils/projectName';

describe('summarizeProjectNameFromPrompt', () => {
  it('summarizes Chinese first prompts into concise project names', () => {
    expect(
      summarizeProjectNameFromPrompt('先实现一下根据项目中的第一个prompt总结项目名称，并自动更改项目名称'),
    ).toBe('自动项目命名');
  });

  it('drops common English request prefixes', () => {
    expect(
      summarizeProjectNameFromPrompt('Please build a settings page for managing desktop pets'),
    ).toBe('Settings Page Managing Desktop Pets');
  });

  it('summarizes turn-this-into prompts by the requested artifact', () => {
    expect(
      summarizeProjectNameFromPrompt(
        'Turn this into an infographic: "5 habits of effective code reviewers — read the PR description first, review tests before implementation"',
      ),
    ).toBe('Infographic 5 Habits Effective Code Reviewers');
  });

  it('ignores code blocks and links before naming', () => {
    expect(
      summarizeProjectNameFromPrompt('Create a dashboard for https://example.com\n```ts\nconst x = 1\n```'),
    ).toBe('Dashboard');
  });

  it('only allows first-prompt renaming for generated project names', () => {
    expect(
      canAutoRenameProjectFromPrompt({
        name: 'Prototype',
        metadata: { kind: 'prototype', nameSource: 'generated' },
      }),
    ).toBe(true);
    expect(
      canAutoRenameProjectFromPrompt({
        name: 'Imported Client Folder',
        metadata: { kind: 'prototype', nameSource: 'user' },
      }),
    ).toBe(false);
    expect(
      canAutoRenameProjectFromPrompt(
        {
          name: 'Turn this into an infographic: "5 habits of',
          metadata: { kind: 'prototype', nameSource: 'prompt' },
        },
        'Turn this into an infographic: "5 habits of effective code reviewers"',
      ),
    ).toBe(true);
    expect(
      canAutoRenameProjectFromPrompt(
        {
          name: 'Infographic 5 Habits Effective Code Reviewers',
          metadata: { kind: 'prototype', nameSource: 'prompt' },
        },
        'Turn this into an infographic: "5 habits of effective code reviewers"',
      ),
    ).toBe(true);
    expect(
      canAutoRenameProjectFromPrompt(
        {
          name: 'Design Router',
          metadata: { kind: 'prototype', nameSource: 'prompt' },
        },
        'Turn this into an infographic: "5 habits of effective code reviewers"',
      ),
    ).toBe(false);
    expect(canAutoRenameProjectFromPrompt({ name: 'Project', metadata: undefined })).toBe(false);
  });
});

describe('displayProjectName', () => {
  const t = (key: 'recentProjects.sharedProjectFallbackName') =>
    key === 'recentProjects.sharedProjectFallbackName' ? 'Shared project' : key;

  it('keeps the daemon sentinel byte-for-byte so stored rows still match', () => {
    expect(SHARED_PROJECT_PLACEHOLDER_NAME).toBe('共享项目');
  });

  it('swaps the placeholder sentinel for the localized label', () => {
    expect(displayProjectName('共享项目', t)).toBe('Shared project');
    expect(displayProjectName('  共享项目 \n', t)).toBe('Shared project');
  });

  it('returns real names unchanged, including ones that merely contain the sentinel', () => {
    expect(displayProjectName('Landing page', t)).toBe('Landing page');
    expect(displayProjectName('共享项目 v2', t)).toBe('共享项目 v2');
    expect(displayProjectName('  Padded  ', t)).toBe('  Padded  ');
  });

  it('tolerates missing names', () => {
    expect(displayProjectName(null, t)).toBe('');
    expect(displayProjectName(undefined, t)).toBe('');
    expect(displayProjectName('', t)).toBe('');
  });
});
