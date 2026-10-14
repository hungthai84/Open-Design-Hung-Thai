// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation, Project } from '../../src/types';
import { RailNewConversation, RailProjectFolder, type RailConversationModel } from '../../src/components/entry-nav-rail/RailConversationTree';
const { listConversations } = vi.hoisted(() => ({ listConversations: vi.fn() }));
vi.mock('../../src/state/projects', () => ({ listConversations }));
vi.mock('../../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/components/entry-nav-rail/RailRecentRow', () => ({
  RailRecentRow: ({ project, expanded, onOpen }: { project: Project; expanded: boolean; onOpen: () => void }) => <button aria-expanded={expanded} onClick={onOpen}>{project.name}</button>,
}));
const project = { id: 'p1', name: 'Project folder' } as Project;
const conversations = [{ id: 'c1', title: 'First conversation', createdAt: 1 }, { id: 'c2', title: 'Second conversation', createdAt: 2 }] as Conversation[];
afterEach(cleanup);
beforeEach(() => { listConversations.mockReset(); listConversations.mockResolvedValue(conversations); });

it('expands a folder without navigation, then opens conversation leaves', async () => {
  const onOpenConversation = vi.fn();
  const context = { workspaceId: 'ws1' } as import('@open-design/contracts').WorkspaceCollabContext;
  render(<RailProjectFolder project={project} context={context} onOpenConversation={onOpenConversation} />);
  expect(listConversations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Project folder' }));
  const child = await screen.findByRole('button', { name: 'First conversation' });
  expect(onOpenConversation).not.toHaveBeenCalled();
  expect(listConversations).toHaveBeenCalledWith('p1', { workspaceContext: context, throwOnError: true });
  fireEvent.click(child);
  expect(onOpenConversation).toHaveBeenCalledWith('p1', 'c1');
  expect(child.hasAttribute('aria-expanded')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Project folder' }));
  expect(screen.getByRole('button', { name: 'Project folder' }).getAttribute('aria-expanded')).toBe('false');
});

it('shows a newly created conversation immediately under its project and selects it', () => {
  const model: RailConversationModel = { projectId: 'p1', conversations: [conversations[0]!], activeConversationId: 'c1', creating: false, onCreate: vi.fn(), onSelect: vi.fn() };
  const { rerender } = render(<RailProjectFolder project={project} model={model} />);
  rerender(<RailProjectFolder project={project} model={{ ...model, conversations, activeConversationId: 'c2' }} />);
  const first = screen.getByRole('button', { name: 'First conversation' });
  const second = screen.getByRole('button', { name: 'Second conversation' });
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(second.getAttribute('aria-current')).toBe('page');
  fireEvent.click(first);
  expect(model.onSelect).toHaveBeenCalledWith('c1');
  expect(listConversations).not.toHaveBeenCalled();
});

it('allows retrying a failed conversation read', async () => {
  listConversations.mockRejectedValueOnce(new Error('offline'));
  render(<RailProjectFolder project={project} />);
  fireEvent.click(screen.getByRole('button', { name: 'Project folder' }));
  fireEvent.click(await screen.findByRole('button', { name: 'preview.retry' }));
  await screen.findByRole('button', { name: 'First conversation' });
  await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(2));
});

it('uses the supplied new-conversation action and disables it while creating', () => {
  const onClick = vi.fn();
  const { rerender } = render(<RailNewConversation onClick={onClick} />);
  fireEvent.click(screen.getByRole('button', { name: 'entry.newConversation' }));
  expect(onClick).toHaveBeenCalledTimes(1);
  rerender(<RailNewConversation onClick={onClick} disabled />);
  fireEvent.click(screen.getByRole('button', { name: 'entry.newConversation' }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('inserts a new conversation directly below the current conversation, without a third level', () => {
  const fresh = { id: 'c3', title: 'New conversation', createdAt: 3 } as Conversation;
  const model: RailConversationModel = { projectId: 'p1', conversations: [...conversations, fresh], activeConversationId: 'c3', creating: false, onCreate: vi.fn(), onSelect: vi.fn(), newConversationPlacement: { id: 'c3', afterId: 'c1' } };
  render(<RailProjectFolder project={project} model={model} />);
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Project folder', 'First conversation', 'New conversation', 'Second conversation']);
  expect(screen.getAllByRole('list')).toHaveLength(1);
});
