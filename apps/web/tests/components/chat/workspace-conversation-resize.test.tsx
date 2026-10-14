// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceConversationResizeHandle } from '../../../src/components/chat/WorkspaceConversationResizeHandle';
import { I18nProvider } from '../../../src/i18n';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness() {
  const [height, setHeight] = useState(480);
  return <I18nProvider initial="en"><WorkspaceConversationResizeHandle
    height={height} minHeight={280} maxHeight={720} onResize={setHeight}
  /></I18nProvider>;
}

it('grows upward, clamps both limits, and ends the pointer interaction cleanly', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  render(<Harness />);
  const handle = screen.getByRole('separator');
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, clientY: 400 });
  fireEvent.pointerMove(handle, { clientY: 280 });
  expect(handle.getAttribute('aria-valuenow')).toBe('600');
  fireEvent.pointerMove(handle, { clientY: -1000 });
  expect(handle.getAttribute('aria-valuenow')).toBe('720');
  fireEvent.pointerMove(handle, { clientY: 1000 });
  expect(handle.getAttribute('aria-valuenow')).toBe('280');
  fireEvent.pointerUp(handle, { clientY: 300 });
  expect(handle.getAttribute('aria-valuenow')).toBe('580');
  expect(document.body.style.cursor).toBe('');
  expect(document.body.style.userSelect).toBe('');
});

it('supports keyboard resizing and restores selection when unmounted mid-drag', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const { unmount } = render(<Harness />);
  const handle = screen.getByRole('separator');
  fireEvent.keyDown(handle, { key: 'ArrowUp' });
  expect(handle.getAttribute('aria-valuenow')).toBe('504');
  fireEvent.keyDown(handle, { key: 'Home' });
  expect(handle.getAttribute('aria-valuenow')).toBe('280');
  fireEvent.keyDown(handle, { key: 'End' });
  expect(handle.getAttribute('aria-valuenow')).toBe('720');
  handle.setPointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, clientY: 400 });
  unmount();
  expect(document.body.style.cursor).toBe('');
  expect(document.body.style.userSelect).toBe('');
});
