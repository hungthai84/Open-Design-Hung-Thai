import type { Project } from '../types';

const MAX_CJK_TITLE_LENGTH = 18;
const MAX_LATIN_WORDS = 6;

const CJK_PATTERN = /[\u3400-\u9fff]/;

const LEADING_CJK_FILLER = [
  /^先?(帮我|帮忙|麻烦|请|可以|能不能|能否|给我|我想要|我要)/,
  /^(先)?(实现|做|做一下|创建|生成|设计|开发|新增|添加|优化|修复|改|更改|调整)(一下|一个|一版|下)?/,
  /^(一个|一份|这个|那个)/,
];

const LEADING_LATIN_FILLER =
  /^(please\s+)?(can\s+you\s+|could\s+you\s+|help\s+me\s+|i\s+want\s+to\s+|i\s+need\s+to\s+)?(create|build|make|design|implement|add|fix|update|improve|optimize|generate|write|turn)\s+((this|that)\s+into\s+)?(an|a|the|this|that)?\s*/i;

const LATIN_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'of',
  'on',
  'please',
  'the',
  'to',
  'with',
]);

function cleanPrompt(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w.-]+/g, ' ')
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimCjkTitle(input: string): string {
  let title = input.trim();
  for (const pattern of LEADING_CJK_FILLER) {
    title = title.replace(pattern, '').trim();
  }
  if (/项目名称/.test(title) && /自动/.test(title) && /(更改|修改|命名)/.test(title)) {
    return '自动项目命名';
  }
  title = title
    .replace(/^根据项目中的?第一个\s*prompt\s*/i, '')
    .replace(/项目名称.*自动.*(更改|修改|命名)/, '自动项目命名')
    .replace(/自动.*(更改|修改).*项目名称/, '自动项目命名')
    .replace(/总结项目名称/, '项目命名')
    .replace(/[，。！？；：,.!?;:].*$/, '')
    .replace(/\s+/g, '');
  if (!title) return '';
  return title.slice(0, MAX_CJK_TITLE_LENGTH);
}

function toTitleCase(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function trimLatinTitle(input: string): string {
  const words = input
    .replace(LEADING_LATIN_FILLER, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !LATIN_STOP_WORDS.has(word.toLowerCase()))
    .slice(0, MAX_LATIN_WORDS);
  return words.map(toTitleCase).join(' ');
}

export function summarizeProjectNameFromPrompt(prompt: string): string {
  const cleaned = cleanPrompt(prompt);
  if (!cleaned) return '';
  const firstClause = cleaned.split(/[\n\r。！？!?]/)[0]?.trim() ?? cleaned;
  if (CJK_PATTERN.test(firstClause)) return trimCjkTitle(firstClause);
  return trimLatinTitle(firstClause);
}

export function canAutoRenameProjectFromPrompt(
  project: Pick<Project, 'metadata' | 'name'>,
  prompt?: string,
): boolean {
  if (project.metadata?.nameSource === 'generated') return true;
  if (project.metadata?.nameSource !== 'prompt' || !prompt) return false;

  const promptHead = prompt.trim().split(/\s+/).slice(0, 8).join(' ');
  const summarized = summarizeProjectNameFromPrompt(prompt);
  const currentName = project.name.trim();
  return Boolean(promptHead) && (currentName === promptHead || currentName === summarized);
}

/**
 * Transport sentinel the daemon stores as the local placeholder name of a
 * shared project while it is being pulled (and permanently when the pulled
 * project carries no name). Must match `PULLED_PROJECT_PLACEHOLDER_NAME` in
 * apps/daemon/src/routes/collab-sync.ts. Use it for logic comparisons only and
 * never render it: show `displayProjectName(...)` instead.
 */
export const SHARED_PROJECT_PLACEHOLDER_NAME = '共享项目';

type SharedProjectFallbackTranslate = (
  key: 'recentProjects.sharedProjectFallbackName',
) => string;

/**
 * The name to show the user for a project. Swaps the daemon's hardcoded
 * placeholder sentinel for the localized "Shared project" label; any other
 * name is returned unchanged. Display only: keep comparisons, sorting and
 * persistence on the raw `project.name`.
 */
export function displayProjectName(
  name: string | null | undefined,
  t: SharedProjectFallbackTranslate,
): string {
  if (name == null) return '';
  return name.trim() === SHARED_PROJECT_PLACEHOLDER_NAME
    ? t('recentProjects.sharedProjectFallbackName')
    : name;
}
