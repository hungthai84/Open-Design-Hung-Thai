// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '../../src/types';
import { I18nProvider } from '../../src/i18n';
import { RailRecentSection } from '../../src/components/EntryNavRail';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  localStorage.removeItem('od.entry.railPersonalOpen');
});

it('brings newly revealed projects into view when View all expands the scrollable list', () => {
  localStorage.setItem('od.entry.railPersonalOpen', 'true');
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const projects = Array.from({ length: 13 }, (_, index) => ({
    id: `project-${index}`,
    name: `Project ${index}`,
    createdAt: 13 - index,
    updatedAt: 13 - index,
  })) as Project[];

  render(<I18nProvider initial="en">
    <RailRecentSection section="personal" scrollable projects={projects} label="All projects" />
  </I18nProvider>);

  const lastRow = screen.getByText('Project 12').closest('li');
  expect(lastRow?.hidden).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'View all' }));
  expect(lastRow?.hidden).toBe(false);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  expect(scrollIntoView.mock.instances).toContain(lastRow);
});
