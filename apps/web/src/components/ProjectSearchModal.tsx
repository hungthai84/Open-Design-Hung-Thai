// Project search palette — opened from the nav rail's search box. A blurred
// full-screen backdrop over a centered card: type to filter projects by name
// and, in a project view, the current project's conversations. Portaled to <body> so the
// blur covers the whole app and the card isn't clipped by the rail.
//
// Ported from #5517; the project list and the open handler come from
// EntryShell's REAL merged catalog (own projects + team-shared cards), so a
// not-yet-pulled shared project opens through the same pull-first path as the
// All Projects grid.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Conversation, Project } from '../types';
import { Icon } from './Icon';
import { useT } from '../i18n';
import { relativeTimeLong } from '../utils/chatTime';
import { conversationMetaLabel } from '../runtime/chat/conversation-time';
import { projectCover, projectCategory, ProjectTag } from './RecentProjectsStrip';
import type { WorkspaceCollabContext } from '@open-design/contracts';

interface Props {
  projects: Project[];
  conversations?: Conversation[];
  currentConversationProjectId?: string;
  onOpenConversation?: (id: string) => void;
  workspaceContext?: WorkspaceCollabContext | null;
  onOpenProject: (id: string) => Promise<boolean> | Promise<void> | boolean | void;
  onClose: () => void;
}

type SearchResult =
  | { kind: 'project'; project: Project }
  | { kind: 'conversation'; conversation: Conversation };

/**
 * Search spans both personal drafts and the shared workspace catalog. Shared
 * cards win if a project temporarily appears in both lists because they carry
 * the authoritative workspace-facing title and metadata.
 */
export function buildProjectSearchCatalog(
  draftProjects: readonly Project[],
  sharedProjects: readonly Project[],
): Project[] {
  const projectsById = new Map<string, Project>();
  for (const project of draftProjects) projectsById.set(project.id, project);
  for (const project of sharedProjects) projectsById.set(project.id, project);
  return [...projectsById.values()];
}

export function ProjectSearchModal({
  projects,
  conversations = [],
  currentConversationProjectId,
  onOpenConversation,
  workspaceContext = null,
  onOpenProject,
  onClose,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  // Keyboard-driven selection: the palette is opened by ⌘K and typed into, so
  // the hands are already on the keys — ↑/↓ move the highlight and Enter opens
  // it, without ever leaving the input (which keeps typing responsive).
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo<SearchResult[]>(() => {
    const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
    const q = query.trim().toLowerCase();
    const projectResults = (q ? sorted.filter((p) => (p.name || '').toLowerCase().includes(q)) : sorted)
      .map((project): SearchResult => ({ kind: 'project', project }));
    if (!q || !onOpenConversation) return projectResults;
    const conversationResults = conversations
      .filter((conversation) => {
        const title = conversation.title || t('chat.untitledConversation');
        const searchable = `${title} ${conversation.id} ${conversationMetaLabel(conversation, t)}`;
        return searchable.toLowerCase().includes(q);
      })
      .map((conversation): SearchResult => ({ kind: 'conversation', conversation }));
    return [...conversationResults, ...projectResults];
  }, [projects, conversations, onOpenConversation, query, t]);
  const currentProjectName = projects.find((project) => project.id === currentConversationProjectId)?.name ?? '';

  // A new query re-ranks the list, so the old index would point at an
  // unrelated row (or past the end) — always restart at the top match.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Follow the highlight when it walks past the visible window.
  useEffect(() => {
    const container = resultsRef.current;
    const active = container?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, filtered.length]);

  const openResult = (result: SearchResult) => {
    if (result.kind === 'conversation') onOpenConversation?.(result.conversation.id);
    else void onOpenProject(result.project.id);
    onClose();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = filtered[Math.min(activeIndex, filtered.length - 1)];
      if (target) openResult(target);
    }
  };

  return createPortal(
    <div
      className="project-search-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="project-search-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('common.search')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-search-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            type="text"
            className="project-search-input"
            value={query}
            placeholder={t('common.search')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            data-testid="project-search-input"
          />
        </div>
        <div className="project-search-results" role="listbox" ref={resultsRef}>
          {filtered.length === 0 ? (
            <div className="project-search-empty">{t('quickSwitcher.noMatches')}</div>
          ) : (
            filtered.map((result, index) => {
              const active = index === activeIndex;
              if (result.kind === 'conversation') {
                const { conversation } = result;
                return (
                  <button
                    key={`conversation-${conversation.id}`}
                    type="button"
                    className={`project-search-item project-search-item--conversation${active ? ' is-active' : ''}`}
                    role="option"
                    aria-selected={active}
                    data-active={active ? 'true' : undefined}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => openResult(result)}
                    data-testid={`conversation-search-item-${conversation.id}`}
                  >
                    <span className="project-search-item-thumb" aria-hidden><Icon name="comment" size={16} /></span>
                    <span className="project-search-item-name">{conversation.title || t('chat.untitledConversation')}</span>
                    <span className="project-search-item-meta">{currentProjectName}</span>
                  </button>
                );
              }
              const { project } = result;
              const cover = projectCover(project, null, workspaceContext);
              const showImage =
                (cover.kind === 'image' || cover.kind === 'logo') && Boolean(cover.src);
              return (
                <button
                  key={project.id}
                  type="button"
                  className={`project-search-item${active ? ' is-active' : ''}`}
                  role="option"
                  aria-selected={active}
                  data-active={active ? 'true' : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => openResult(result)}
                  data-testid={`project-search-item-${project.id}`}
                >
                  <span
                    className="project-search-item-thumb"
                    style={cover.style}
                    aria-hidden
                  >
                    {showImage ? (
                      <img src={cover.src} alt="" loading="lazy" />
                    ) : (
                      <span className="project-search-item-glyph">{cover.initial}</span>
                    )}
                  </span>
                  <span className="project-search-item-name">
                    {project.name || t('chat.untitledConversation')}
                  </span>
                  <span className="project-search-item-tag">
                    <ProjectTag category={projectCategory(project)} />
                  </span>
                  <span className="project-search-item-meta">
                    {relativeTimeLong(project.updatedAt, t)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
