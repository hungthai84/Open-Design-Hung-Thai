// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { TabLauncherMenu } from '../../src/components/workspace/TabLauncherMenu';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  const close = vi.fn();
  const anchor = document.createElement('button');
  render(<I18nProvider initial="en"><TabLauncherMenu anchor={anchor}
    files={[]} openTabNames={[]} actions={[]}
    launcherContext={{ projectId: 'project', openTab: vi.fn() }}
    onOpenFile={vi.fn()} onClose={close} /></I18nProvider>);
  return { close, anchor };
}

it('dismisses an outside press even when the target stops propagation', () => {
  const { close } = setup();
  render(<button onPointerDown={event => event.stopPropagation()}>Outside</button>);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps menu interactions open and still supports Escape', () => {
  const { close } = setup();
  fireEvent.pointerDown(screen.getByTestId('tab-launcher-search'));
  fireEvent.click(screen.getByTestId('tab-launcher-search'));
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});

it('dismisses when focus moves into the preview iframe', () => {
  let nextFrame: FrameRequestCallback | undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { nextFrame = callback; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const { close } = setup();
  render(<iframe title="Preview" />);
  screen.getByTitle('Preview').focus();
  fireEvent.blur(window);
  act(() => nextFrame?.(0));
  expect(close).toHaveBeenCalledOnce();
});
