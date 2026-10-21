// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../../src/components/AssistantMessage';
import { foldStrategyTaskTurns } from '../../../src/components/ChatPane';
import { I18nProvider } from '../../../src/i18n';
import { withTaskPresentation } from '../../../src/runtime/chat/task-presentation';
import type { ChatMessage } from '../../../src/types';

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function productionTurn(state: 'running' | 'completed' | 'failed' | 'canceled' = 'running', conclusion = '') {
  const display = { id: 'task', revision: 4, currentRunId: 'production', runIds: ['plan', 'production'],
    state, elapsedMs: 26_000, observedAt: Date.now(), ticking: false };
  const rows: ChatMessage[] = [
    { id: 'plan-message', role: 'assistant', runId: 'plan', runStatus: 'succeeded',
      strategyTaskExecutionId: 'task', strategyTaskRunIndex: 0, taskDisplay: display,
      content: '<od-done key="aaaaaaaaaaaaaaaa"/>The plan is ready.',
      events: [{ kind: 'done_key', key: 'aaaaaaaaaaaaaaaa' }, { kind: 'thinking', text: 'Plan thinking' },
        { kind: 'text', text: '<od-done key="aaaaaaaaaaaaaaaa"/>The plan is ready.' }] },
    { id: 'production-message', role: 'assistant', runId: 'production',
      runStatus: state === 'completed' ? 'succeeded' : state,
      strategyTaskExecutionId: 'task', strategyTaskRunIndex: 1, taskDisplay: display,
      content: conclusion, events: [{ kind: 'done_key', key: 'bbbbbbbbbbbbbbbb' },
        { kind: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'index.html', content: '<title>Site</title>' } },
        ...(conclusion ? [{ kind: 'text' as const, text: '<od-done key="bbbbbbbbbbbbbbbb"/>' + conclusion }] : [])] },
  ];
  return foldStrategyTaskTurns(rows)[0]!;
}
function chat(message: ChatMessage, streaming = message.runStatus === 'running') {
  return <I18nProvider initial="en"><AssistantMessage message={message} streaming={streaming}
    projectId="project" conversationId="conversation" /></I18nProvider>;
}
function record(container: HTMLElement) {
  return container.querySelector<HTMLDetailsElement>('[data-testid="assistant-flow"] > details')!;
}

it('uses the existing clickable status and elapsed header for the combined automatic Runs', () => {
  const view = render(chat(productionTurn()));
  const outer = record(view.container);
  expect(outer).toHaveAttribute('open');
  expect(outer.querySelector('summary')).toHaveTextContent('Working26s');
  expect(outer.querySelector('summary [data-orb="connecting"]')).not.toBeNull();
  expect(screen.queryByText('Execution record')).toBeNull();
  expect(screen.queryByTestId('task-display-status')).toBeNull();
  const thoughts = screen.getByText('Thoughts').closest('details')!;
  fireEvent.click(thoughts.querySelector('summary')!);
  fireEvent(thoughts, new Event('toggle'));
  expect(screen.getAllByText('Plan thinking')).toHaveLength(1);
  expect(screen.getAllByText('The plan is ready.')).toHaveLength(1);
  expect(screen.getAllByText('Wrote')).toHaveLength(1);
});

it('does not expose a planning completion footer before the production boundary arrives', () => {
  const merged = productionTurn();
  const display = merged.taskDisplay!;
  const messages = withTaskPresentation(foldStrategyTaskTurns([
    { id: 'plan-message', role: 'assistant', runId: 'plan', runStatus: 'succeeded',
      strategyTaskExecutionId: 'task', strategyTaskRunIndex: 0, taskDisplay: display,
      content: '<od-done key="aaaaaaaaaaaaaaaa"/>The plan is ready.',
      events: [{ kind: 'done_key', key: 'aaaaaaaaaaaaaaaa' }, { kind: 'thinking', text: 'Planning' },
        { kind: 'text', text: '<od-done key="aaaaaaaaaaaaaaaa"/>The plan is ready.' }] },
    { id: 'production-message', role: 'assistant', runId: 'production', runStatus: 'running',
      strategyTaskExecutionId: 'task', strategyTaskRunIndex: 1, taskDisplay: display, content: '', events: [] },
  ]));
  expect(messages).toHaveLength(2);
  const view = render(<I18nProvider initial="en">{messages.map(message => <AssistantMessage key={message.id}
    message={message} taskPresentation={message.taskPresentation} streaming={message.runStatus === 'running'}
    isLast={message.runId === 'production'} onFeedback={vi.fn()} projectId="project" conversationId="conversation" />)}</I18nProvider>);
  expect(record(view.container).querySelector('summary')).toHaveTextContent('Working');
  expect(screen.queryByText('Done')).toBeNull();
  expect(screen.queryByTestId('assistant-feedback')).toBeNull();
});

it('preserves a manual fold while streaming and resets to the normal lifecycle after reopening', () => {
  const view = render(chat(productionTurn()));
  const outer = record(view.container);
  fireEvent.click(outer.querySelector('summary')!);
  fireEvent(outer, new Event('toggle'));
  expect(outer).not.toHaveAttribute('open');
  view.rerender(chat(productionTurn('completed', 'Final design.')));
  expect(record(view.container)).not.toHaveAttribute('open');
  view.unmount();
  const reopened = render(chat(productionTurn()));
  expect(record(reopened.container)).toHaveAttribute('open');
});

it('keeps a manual fold when planning hands off to automatic production', () => {
  const merged = productionTurn();
  const planning: ChatMessage = { ...merged, runId: 'plan', strategyTaskRunIndex: 0,
    strategyTaskPrefixEventCount: 0, content: '',
    taskDisplay: { ...merged.taskDisplay!, currentRunId: 'plan', runIds: ['plan'] },
    events: [{ kind: 'done_key', key: 'aaaaaaaaaaaaaaaa' }, { kind: 'thinking', text: 'Plan thinking' }] };
  const view = render(chat(planning));
  const outer = record(view.container);
  fireEvent.click(outer.querySelector('summary')!);
  fireEvent(outer, new Event('toggle'));
  expect(outer).not.toHaveAttribute('open');
  view.rerender(chat(merged));
  expect(record(view.container)).not.toHaveAttribute('open');
});

it('collapses on the final production conclusion without waiting for the stream to close', () => {
  const view = render(chat(productionTurn()));
  view.rerender(chat(productionTurn('running', 'Final design.')));
  expect(record(view.container)).not.toHaveAttribute('open');
  expect(screen.getByText('Final design.').closest('details')).toBeNull();
});

it.each(['failed', 'canceled'] as const)('keeps the existing %s header and folding behavior', state => {
  const view = render(chat(productionTurn()));
  view.rerender(chat(productionTurn(state)));
  const outer = record(view.container);
  expect(outer.querySelector('summary')).toHaveTextContent(state === 'failed' ? 'Run failed' : 'Canceled');
  expect(outer.querySelector('summary')).toHaveTextContent('26s');
  expect(outer.hasAttribute('open')).toBe(state === 'canceled');
  expect(outer.querySelector('summary [data-orb]')).toBeNull();
});

it('leaves a single Run and plain text answers on the original rendering path', () => {
  const merged = productionTurn();
  const single = { ...merged, runId: 'production', strategyTaskPrefixEventCount: 0,
    taskDisplay: { ...merged.taskDisplay!, runIds: ['production'] }, content: '',
    events: [{ kind: 'thinking' as const, text: 'Thinking about the request.' }] };
  const view = render(chat(single));
  expect(record(view.container).querySelector('summary')).toHaveTextContent('Working');
  expect(screen.queryByTestId('task-display-status')).toBeNull();
  view.rerender(chat({ ...single, runStatus: 'succeeded', taskDisplay: { ...single.taskDisplay, state: 'completed' },
    content: 'Text answer.', events: [{ kind: 'text', text: 'Text answer.' }] }, false));
  expect(record(view.container)).toBeNull();
  expect(screen.getByText('Text answer.').closest('details')).toBeNull();
});
