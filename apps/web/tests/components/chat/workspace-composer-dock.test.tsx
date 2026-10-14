// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../../../src/components/chat/ProjectChatPane';
import { I18nProvider } from '../../../src/i18n';

vi.mock('../../../src/components/chat/upstream/ChatComposer', () => ({
  ChatComposer: forwardRef(() => {
    const [menuOpen, setMenuOpen] = useState(false);
    return <><input aria-label="Draft" defaultValue="Existing draft" />
      <button onClick={() => setMenuOpen(true)}>Composer tools</button>
      {menuOpen ? createPortal(<button>Portaled composer action</button>, document.body) : null}
    </>;
  }),
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('docks the actual project composer inside the workspace and restores the same draft', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const workspace = this.getAttribute('data-testid') === 'file-workspace';
    return { left: 0, right: workspace ? 1000 : 320, width: workspace ? 1000 : 320,
      top: 50, bottom: 700, height: 650, x: 0, y: 50, toJSON: () => ({}) } as DOMRect;
  });
  const expand = vi.fn();
  const view = (docked: boolean, expanded = false) => <I18nProvider initial="en"><div className="split">
    <div aria-hidden={(docked && !expanded) || undefined}>
      <ChatPane messages={[]} streaming={false} error={null} projectId="p1" projectFiles={[]}
        conversations={[]} activeConversationId="c1" onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()}
        onEnsureProject={async () => 'p1'} onSend={vi.fn()} onStop={vi.fn()}
        workspaceComposerDocked={docked} workspaceConversationExpanded={expanded} onExpandConversation={expand} />
    </div>
    <div data-testid="file-workspace" />
  </div></I18nProvider>;
  const { rerender } = render(view(false));
  const input = screen.getByRole('textbox', { name: 'Draft' });
  const transcript = screen.getByTestId('chat-log');
  fireEvent.change(input, { target: { value: 'Keep my edited draft' } });
  rerender(view(true));
  const dock = screen.getByTestId('chat-composer-floating-layer');
  expect(dock.style.left).toBe('504px');
  expect(dock.style.width).toBe('480px');
  expect(dock.closest('[aria-hidden="true"]')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
  fireEvent.click(screen.getByTestId('chat-composer-expand'));
  expect(expand).toHaveBeenCalledOnce();
  rerender(view(true, true));
  const popover = screen.getByTestId('workspace-conversation-popover');
  expect(popover.contains(transcript)).toBe(true);
  expect(popover.closest('[aria-hidden="true"]')).toBeNull();
  expect(screen.getByTestId('chat-log')).toBe(transcript);
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
  expect(screen.getAllByTestId('chat-composer-expand')).toHaveLength(1);
  expect(screen.getByTestId('chat-composer-expand').getAttribute('aria-expanded')).toBe('true');
  expect(dock.style.left).toBe('504px');
  fireEvent.click(screen.getByTestId('chat-composer-expand'));
  expect(expand).toHaveBeenCalledTimes(2);
  rerender(view(true));
  expect(screen.queryByTestId('workspace-conversation-popover')).toBeNull();
  expect(screen.getByTestId('chat-log')).toBe(transcript);
  expect(screen.getByDisplayValue('Keep my edited draft')).toBe(input);
  rerender(view(false));
  expect(screen.queryByTestId('chat-composer-expand')).toBeNull();
  expect(screen.getByDisplayValue('Keep my edited draft')).toBe(input);
  expect(dock.style.left).toBe('0px');
  expect(dock.style.width).toBe('320px');
});

it('expands on focus, keeps its portaled menu open, collapses outside, and restores a minimized draft', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, right: 1000, width: 1000, top: 50, bottom: 700, height: 650,
    x: 0, y: 50, toJSON: () => ({}),
  } as DOMRect);
  function Harness() {
    const [expanded, setExpanded] = useState(false);
    return <I18nProvider initial="en"><button>Outside</button><div className="split">
      <div aria-hidden={!expanded || undefined}>
        <ChatPane messages={[]} streaming={false} error={null} projectId="p1" projectFiles={[]}
          conversations={[]} activeConversationId="c1" onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()}
          onEnsureProject={async () => 'p1'} onSend={vi.fn()} onStop={vi.fn()}
          workspaceComposerDocked workspaceConversationExpanded={expanded}
          onWorkspaceConversationExpandedChange={setExpanded}
          onExpandConversation={() => setExpanded(value => !value)} />
      </div><div data-testid="file-workspace" />
    </div></I18nProvider>;
  }
  render(<Harness />);
  const input = screen.getByRole('textbox', { name: 'Draft' });
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  expect(screen.queryByTestId('workspace-conversation-popover')).toBeNull();
  fireEvent.focus(input);
  expect(screen.getByTestId('workspace-conversation-popover')).toBeTruthy();
  fireEvent.pointerDown(screen.getByTestId('chat-log'));
  expect(screen.getByTestId('workspace-conversation-popover')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Composer tools' }));
  const composerAction = screen.getByRole('button', { name: 'Portaled composer action' });
  fireEvent.pointerDown(composerAction);
  fireEvent.focus(composerAction);
  expect(screen.getByTestId('workspace-conversation-popover')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Conversation position' }));
  const minimize = screen.getByRole('menuitem', { name: 'Minimize to bubble' });
  fireEvent.pointerDown(minimize);
  expect(screen.getByTestId('workspace-conversation-popover')).toBeTruthy();
  fireEvent.click(minimize);
  expect(screen.queryByTestId('workspace-conversation-popover')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Draft' })).toBeNull();
  expect(screen.getByDisplayValue('Keep this draft')).toBe(input);
  fireEvent.click(screen.getByTestId('chat-composer-bubble'));
  expect(screen.queryByTestId('chat-composer-bubble')).toBeNull();
  expect(screen.getByTestId('workspace-conversation-popover')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
  expect(document.activeElement).toBe(input);
  fireEvent.focus(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByTestId('workspace-conversation-popover')).toBeNull();
  fireEvent.focus(input);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByTestId('workspace-conversation-popover')).toBeNull();
});
