// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAxionWalkthroughInteractionGate } from '../../src/components/AxionWalkthroughInteractionGate';
import { PrimaryNavigationRail } from '../../src/components/PrimaryNavigationRail';
import { I18nProvider } from '../../src/i18n';

const PROJECT_ID = 'e69c2998-5db8-4b78-bf4c-04d0c5f1b815';

afterEach(cleanup);

function Harness({ projectId = PROJECT_ID, onNavigate = vi.fn(), onAction = vi.fn() }) {
  useAxionWalkthroughInteractionGate(projectId);
  return (
    <I18nProvider initial="en">
      <PrimaryNavigationRail
        view={null}
        homeActive
        placement="overlay"
        testIdPrefix="project-nav"
        onHome={() => onNavigate('home')}
        onViewChange={onNavigate}
        context={null}
        accountHostRef={() => {}}
      />
      <button onClick={onAction}>Restricted action</button>
    </I18nProvider>
  );
}

describe('Axion walkthrough navigation', () => {
  it.each(['home', 'community', 'design-systems', 'plugins'])(
    'allows pointer navigation to %s from the walkthrough', (destination) => {
      const onNavigate = vi.fn();
      render(<Harness onNavigate={onNavigate} />);
      const button = screen.getByTestId(`project-nav-${destination}`);
      // Icons are the pointer target in the compact rail.
      const target = button.querySelector('svg') ?? button;
      expect(fireEvent.pointerDown(target)).toBe(true);
      expect(fireEvent.mouseDown(target)).toBe(true);
      fireEvent.click(target);
      expect(onNavigate).toHaveBeenCalledWith(destination);
    },
  );

  it.each(['Enter', ' '])('does not cancel navigation activation with %j', (key) => {
    render(<Harness />);
    expect(fireEvent.keyDown(screen.getByTestId('project-nav-home'), { key })).toBe(true);
  });

  it('keeps demonstration actions restricted and removes the gate after leaving', () => {
    const onAction = vi.fn();
    const { rerender } = render(<Harness onAction={onAction} />);
    const action = screen.getByRole('button', { name: 'Restricted action' });
    fireEvent.click(action);
    expect(onAction).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(action, { key: 'Enter' })).toBe(false);

    rerender(<Harness projectId="another-project" onAction={onAction} />);
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledOnce();
  });
});
