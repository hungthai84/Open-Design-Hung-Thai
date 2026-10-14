// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasDockIndicator } from '../../src/components/CanvasDockIndicator';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tools = ['board-mode-toggle', 'draw-overlay-toggle', 'comment-panel-toggle',
  'manual-edit-mode-toggle', 'canvas-dock-present-toggle', 'canvas-dock-zoom-toggle'];
const pairs = tools.flatMap(from => tools.filter(to => to !== from).map(to => [from, to] as const));

it.each(pairs)('animates %s → %s through resize and a temporary empty selection', (from, to) => {
  vi.useFakeTimers();
  let resize = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const x = this.dataset.testid === to ? 80 : 0;
    return { x, y: 0, left: x, top: 0, width: 32, height: 32, right: x + 32, bottom: 32, toJSON() {} };
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (target: string | null) => act(() => root.render(<div>
    <CanvasDockIndicator target={target} /><button data-testid={from} /><button data-testid={to} />
  </div>));
  try {
    render(from);
    const pill = host.querySelector('span')!;
    expect(pill.hidden).toBe(false);
    render(to);
    expect(pill.dataset.phase).toBe('stretch');
    expect(pill.style.width).toBe('112px');
    act(() => { resize(); resize(); });
    expect(pill.dataset.phase).toBe('stretch');
    act(() => vi.advanceTimersByTime(190));
    expect(pill.dataset.phase).toBe('settle');
    expect(pill.style.transform).toBe('translate(80px, 0px)');
    render(from);
    render(null);
    act(() => vi.runAllTimers());
    expect(pill.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    render(to);
    expect(pill.dataset.phase).toBe('stretch');
    expect(pill.hidden).toBe(false);
    act(() => vi.advanceTimersByTime(190));
    expect(pill.dataset.phase).toBe('settle');
    expect(host.querySelector(`[data-testid="${to}"]`)?.getAttribute('data-dock-selected')).toBe('true');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
