import { useEffect } from 'react';

const AXION_WALKTHROUGH_PROJECT_ID = 'e69c2998-5db8-4b78-bf4c-04d0c5f1b815';

const ALWAYS_INTERACTIVE = [
  // App destinations must stay reachable while the project demo is gated.
  '.project-destinations button[data-testid^="project-nav-"]',
  '[data-testid="workspace-tabs-dock"]',
  '[data-testid="workspace-tabs-dock-focus"]',
  '[data-testid="workspace-focus-toggle"]',
  '.workspace-tabs-dropdown__actions',
  '[data-testid="project-preview-tab"]',
  '[data-testid="workspace-code-tab"]',
  '[data-testid="workspace-code-tab-idle"]',
  '[data-testid="design-files-tab"]',
  '.viewer-viewport-switcher',
  '[data-testid="canvas-dock"]',
  '[data-testid="canvas-dock-present-popover"]',
  // The generated page stays untouched inside its active preview frame.
  '[data-testid="retained-file-viewer"] iframe[data-od-active="true"]',
  '.preview-draw-dock',
  '.preview-draw-overlay-active > canvas',
  '.preview-draw-text-mark',
  '.comment-saved-marker',
  '[data-testid="comment-popover"]',
  '[data-testid="comment-side-panel"]',
  '[data-testid="comment-side-collapsed-rail"]',
  '.manual-edit-right',
  '[data-testid="manual-edit-hover-open"]',
  '[data-testid="inspect-panel"]',
  '.present-overlay',
].join(', ');

function isAllowed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(ALWAYS_INTERACTIVE));
}

/** Makes the teaching project a UI demonstration without changing other projects. */
export function useAxionWalkthroughInteractionGate(projectId: string | null): void {
  useEffect(() => {
    if (projectId !== AXION_WALKTHROUGH_PROJECT_ID) return;

    const stopPointerAction = (event: MouseEvent | PointerEvent) => {
      if (isAllowed(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const stopKeyboardAction = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (isAllowed(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const stopFormAction = (event: SubmitEvent) => {
      if (isAllowed(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    document.addEventListener('pointerdown', stopPointerAction, true);
    document.addEventListener('mousedown', stopPointerAction, true);
    document.addEventListener('click', stopPointerAction, true);
    document.addEventListener('keydown', stopKeyboardAction, true);
    document.addEventListener('submit', stopFormAction, true);
    return () => {
      document.removeEventListener('pointerdown', stopPointerAction, true);
      document.removeEventListener('mousedown', stopPointerAction, true);
      document.removeEventListener('click', stopPointerAction, true);
      document.removeEventListener('keydown', stopKeyboardAction, true);
      document.removeEventListener('submit', stopFormAction, true);
    };
  }, [projectId]);
}
