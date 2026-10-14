// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceComposerHeader } from '../../../src/components/chat/WorkspaceComposerHeader';
import { I18nProvider } from '../../../src/i18n';

afterEach(cleanup);
it('shows the conversation title and dispatches both pane placement actions', () => {
  const place = vi.fn();
  const expand = vi.fn();
  const { container } = render(<I18nProvider initial="zh-CN"><WorkspaceComposerHeader title="当前对话"
    onExpand={expand} onPlacementChange={place} /></I18nProvider>);
  expect(screen.getByText('当前对话')).toBeTruthy();
  fireEvent.click(screen.getByTestId('chat-composer-expand'));
  expect(expand).toHaveBeenCalledOnce();
  for (const [label, value] of [['移至左侧窗格', 'left'], ['移至右侧窗格', 'right']]) {
    fireEvent.click(screen.getByRole('button', { name: '对话位置' }));
    expect(screen.queryByRole('menuitem', { name: '在完整视图中打开' })).toBeNull();
    const item = screen.getByRole('menuitem', { name: label });
    expect(container.contains(item)).toBe(false);
    fireEvent.pointerDown(item);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(item);
    expect(place).toHaveBeenLastCalledWith(value);
    expect(screen.queryByRole('menu')).toBeNull();
  }
});

it('supports keyboard navigation, Escape and outside dismissal', () => {
  render(<I18nProvider initial="en"><WorkspaceComposerHeader title="Conversation" /></I18nProvider>);
  const trigger = screen.getByRole('button', { name: 'Conversation position' });
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move to left pane' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move to right pane' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
});
