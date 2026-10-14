import { useLayoutEffect, useRef } from 'react';

/** A shared pill stretches between tools, then catches up with a soft overshoot. */
export function CanvasDockIndicator({ target }: { target: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<string | null>(null);

  useLayoutEffect(() => {
    const pill = ref.current;
    const dock = pill?.parentElement;
    if (!pill || !dock) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    const measure = (element: HTMLElement) => {
      const outer = dock.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const scale = dock.offsetWidth > 0 ? outer.width / dock.offsetWidth || 1 : 1;
      return { x: (rect.left - outer.left) / scale + dock.scrollLeft,
        y: (rect.top - outer.top) / scale, width: rect.width / scale, height: rect.height / scale };
    };
    const place = (box: ReturnType<typeof measure>, phase: string) => {
      pill.dataset.phase = phase;
      pill.style.transform = `translate(${box.x}px, ${box.y}px)`;
      pill.style.width = `${box.width}px`;
      pill.style.height = `${box.height}px`;
    };
    const button = target ? dock.querySelector<HTMLElement>(`[data-testid="${target}"]`) : null;
    if (!button) {
      pill.hidden = true;
      return;
    }
    button.dataset.dockSelected = 'true';
    const destination = measure(button);
    const previousButton = previous.current
      ? dock.querySelector<HTMLElement>(`[data-testid="${previous.current}"]`) : null;
    if (previousButton && previous.current !== target && !reduced?.matches) {
      // Read the live shape so rapid switches continue from the current animation.
      // A safe edit-mode exit can temporarily clear selection; retain its origin.
      const from = pill.hidden ? measure(previousButton) : measure(pill);
      pill.hidden = false;
      place(from, 'idle');
      void pill.offsetWidth;
      const left = Math.min(from.x, destination.x);
      const right = Math.max(from.x + from.width, destination.x + destination.width);
      place({ ...destination, x: left, width: right - left }, 'stretch');
      timer = setTimeout(() => place(measure(button), 'settle'), 190);
    } else {
      place(destination, 'idle');
    }
    pill.hidden = false;
    previous.current = target;
    const sync = () => {
      if (timer) clearTimeout(timer);
      place(measure(button), 'idle');
    };
    // Skip the initial observer delivery, which would cancel the stretch.
    let initial = true;
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (initial) { initial = false; return; }
      const next = measure(button);
      if (!reduced?.matches && pill.dataset.phase === 'stretch') {
        const current = measure(pill);
        const left = Math.min(current.x, next.x);
        const right = Math.max(current.x + current.width, next.x + next.width);
        place({ ...next, x: left, width: right - left }, 'stretch');
      } else {
        place(next, reduced?.matches ? 'idle' : pill.dataset.phase ?? 'idle');
      }
    }) : null;
    resizeObserver?.observe(dock);
    resizeObserver?.observe(button);
    reduced?.addEventListener('change', sync);
    return () => {
      if (timer) clearTimeout(timer);
      delete button.dataset.dockSelected;
      resizeObserver?.disconnect();
      reduced?.removeEventListener('change', sync);
    };
  }, [target]);

  return <span ref={ref} className="canvas-dock-indicator" aria-hidden="true" hidden />;
}
