// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { KEY_ENTER_COMMAND } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChatComposer,
  STAGE_ATTACHMENT_EVENT,
  type ChatSendOutcome,
} from '../../src/components/ChatComposer';
import type { ChatQuote } from '../../src/runtime/chat/quote-selection';
import { composerText, flushMounts, getComposerEditor, typeAndSettle } from '../helpers/lexical-composer';

/*
 * OPEND-3392: the host already paints the sent turn (and flips to Working)
 * before its OpenDesign Cloud balance preflight settles, so the composer must
 * not keep showing the sent prompt for that round trip. It empties on submit;
 * only a send the host hands back (`'restore-draft'`) or that throws comes back.
 */

function renderComposer(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  return render(
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      skills={[]}
      {...overrides}
    />,
  );
}

function deferredSend() {
  let settle!: (outcome: ChatSendOutcome) => void;
  let fail!: (error: unknown) => void;
  const onSend = vi.fn(
    (_prompt: string) =>
      new Promise<ChatSendOutcome>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
  );
  return {
    onSend,
    settle: (outcome: ChatSendOutcome) => settle(outcome),
    fail: (error: unknown) => fail(error),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), { status: 200 });
      }
      if (url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), { status: 200 });
      }
      if (url === '/api/skills') {
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  cleanup();
});

describe('ChatComposer clears on submit (OPEND-3392)', () => {
  it('empties the composer as soon as the send is submitted, before the host settles', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();

    await typeAndSettle('背景色改成青色');
    fireEvent.click(screen.getByTestId('chat-send'));

    expect(send.onSend).toHaveBeenCalledTimes(1);
    expect(send.onSend.mock.calls[0]?.[0]).toBe('背景色改成青色');
    await waitFor(() => expect(composerText().trim()).toBe(''));
    // The pending pill still guards against a second submit meanwhile.
    expect(screen.getByTestId('chat-send-pending')).toHaveAttribute('aria-busy', 'true');

    await act(async () => send.settle(undefined));
    await waitFor(() => expect(screen.queryByTestId('chat-send-pending')).toBeNull());
    expect(composerText().trim()).toBe('');
  });

  it('puts the prompt and quotes back when the host hands the send back', async () => {
    const send = deferredSend();
    const quotes: ChatQuote[] = [{ id: 'q1', text: '商品卡', messageId: 'm1' }];
    const onClearQuotes = vi.fn();
    const onRestoreQuotes = vi.fn();
    renderComposer({ onSend: send.onSend, quotes, onClearQuotes, onRestoreQuotes });
    await flushMounts();

    await typeAndSettle('keep this exact prompt');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));
    expect(onClearQuotes).toHaveBeenCalledTimes(1);

    await act(async () => send.settle('restore-draft'));
    await waitFor(() => expect(composerText()).toBe('keep this exact prompt'));
    expect(onRestoreQuotes).toHaveBeenCalledWith(quotes);
  });

  it('restores after Enter flushes React reset before Lexical commits its cleared state', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();
    await typeAndSettle('restore after authority changes');
    // Enter handlers run inside a Lexical update. React may commit the reset
    // before that outer update commits the editor's previous nonempty state.
    const editor = getComposerEditor();
    act(() => editor.update(() => {
      flushSync(() => editor.dispatchCommand(KEY_ENTER_COMMAND, null));
    }, { discrete: true }));
    await waitFor(() => expect(composerText().trim()).toBe(''));
    await act(async () => send.settle('restore-draft'));
    expect(composerText()).toBe('restore after authority changes');
  });

  it('puts the prompt back when the send throws', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();

    await typeAndSettle('network hiccup');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));

    await act(async () => send.fail(new Error('boom')));
    await waitFor(() => expect(composerText()).toBe('network hiccup'));
  });

  it('does not overwrite a new prompt typed while the send was pending', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();

    await typeAndSettle('first prompt');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));

    await typeAndSettle('second thought');
    await act(async () => send.settle('restore-draft'));
    await flushMounts();
    expect(composerText()).toBe('second thought');
  });
  it('keeps a non-text attachment staged while the send was pending instead of restoring over it', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();

    await typeAndSettle('first prompt');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));

    act(() => {
      window.dispatchEvent(new CustomEvent(STAGE_ATTACHMENT_EVENT, {
        detail: { attachments: [{ path: 'shots/next.png', name: 'next.png', kind: 'image' }] },
      }));
    });
    expect(screen.getByRole('button', { name: 'Preview next.png' })).toBeTruthy();

    await act(async () => send.settle('restore-draft'));
    await flushMounts();
    expect(screen.getByRole('button', { name: 'Preview next.png' })).toBeTruthy();
    expect(composerText().trim()).toBe('');
  });

  it('does not restore over a quote the host staged while the send was pending', async () => {
    const send = deferredSend();
    const sentQuotes: ChatQuote[] = [{ id: 'q1', text: '旧引用', messageId: 'm1' }];
    const onRestoreQuotes = vi.fn();
    const { rerender } = renderComposer({
      onSend: send.onSend,
      quotes: sentQuotes,
      onClearQuotes: vi.fn(),
      onRestoreQuotes,
    });
    await flushMounts();

    await typeAndSettle('first prompt');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));

    rerender(
      <ChatComposer
        projectId="project-1"
        projectFiles={[]}
        streaming={false}
        onEnsureProject={async () => 'project-1'}
        onSend={send.onSend}
        onStop={vi.fn()}
        skills={[]}
        quotes={[{ id: 'q2', text: '新引用', messageId: 'm2' }]}
        onClearQuotes={vi.fn()}
        onRestoreQuotes={onRestoreQuotes}
      />,
    );

    await act(async () => send.settle('restore-draft'));
    await flushMounts();
    expect(onRestoreQuotes).not.toHaveBeenCalled();
    expect(composerText().trim()).toBe('');
  });
  it('does not restore a submitted draft after the user edits then clears the next draft', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();
    await typeAndSettle('original');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));
    await typeAndSettle('new draft');
    await typeAndSettle('');
    await act(async () => send.settle('restore-draft'));
    expect(composerText().trim()).toBe('');
  });

  it('returns the submitted attachment with its prompt after final admission rejects', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();
    act(() => window.dispatchEvent(new CustomEvent(STAGE_ATTACHMENT_EVENT, {
      detail: { attachments: [{ path: 'shots/original.png', name: 'original.png', kind: 'image' }] },
    })));
    await typeAndSettle('original attachment');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));
    expect(screen.queryByRole('button', { name: 'Preview original.png' })).toBeNull();
    await act(async () => send.settle('restore-draft'));
    expect(composerText()).toBe('original attachment');
    expect(screen.getByRole('button', { name: 'Preview original.png' })).toBeTruthy();
  });

  it('does not clear later text or attachments when an earlier start finally arrives', async () => {
    const send = deferredSend();
    renderComposer({ onSend: send.onSend });
    await flushMounts();
    await typeAndSettle('submitted');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(composerText().trim()).toBe(''));
    await typeAndSettle('next draft');
    act(() => window.dispatchEvent(new CustomEvent(STAGE_ATTACHMENT_EVENT, {
      detail: { attachments: [{ path: 'shots/next.png', name: 'next.png', kind: 'image' }] },
    })));
    await act(async () => send.settle(undefined));
    expect(composerText()).toBe('next draft');
    expect(screen.getByRole('button', { name: 'Preview next.png' })).toBeTruthy();
  });

});
