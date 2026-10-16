// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PreviewDocumentFrame } from '../../src/components/PreviewDocumentFrame';

afterEach(cleanup);

function dispatch(frame: HTMLIFrameElement, data: Record<string, unknown>, source = frame.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent('message', { source, data })));
}

function ready(frame: HTMLIFrameElement, post: MockInstance<Window['postMessage']>, documentId: string) {
  dispatch(frame, { type: 'od:srcdoc-transport-ready', documentId });
  const probe = post.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-shell-probe').at(-1)?.[0];
  dispatch(frame, { type: 'od:srcdoc-transport-ready', documentId, probeId: probe?.probeId });
}

describe('native auxiliary preview document lifecycle (OPEND-3782)', () => {
  const props = { srcDoc: '<html><body><h1>Complete preview</h1></body></html>', documentUrl: 'http://localhost/api/projects/p/preview/scope111/deck.html' };

  it('activates each new native document once, including a same-URL reload', () => {
    const { container } = render(<PreviewDocumentFrame {...props} />);
    const frame = container.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    ready(frame, post, 'document-1');
    ready(frame, post, 'document-1');
    expect(post.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-activate')).toHaveLength(1);
    fireEvent.load(frame);
    ready(frame, post, 'document-2');
    const activations = post.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-activate').map(([message]) => message);
    expect(activations).toHaveLength(2);
    expect(activations.map(message => message.documentId)).toEqual(['document-1', 'document-2']);
    ready(frame, post, 'document-1');
    expect(post.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-activate')).toHaveLength(2);
  });

  it('accepts completion only for the active document and content generation', () => {
    const onReady = vi.fn();
    const { container } = render(<PreviewDocumentFrame {...props} onReady={onReady} />);
    const frame = container.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    ready(frame, post, 'document-1');
    dispatch(frame, { type: 'od:srcdoc-transport-activated', documentId: 'document-1', generation: 'auxiliary-preview', bodyComplete: false });
    dispatch(frame, { type: 'od:srcdoc-transport-activated', documentId: 'stale-document', generation: 'auxiliary-preview', bodyComplete: true });
    dispatch(frame, { type: 'od:srcdoc-transport-activated', documentId: 'document-1', generation: 'stale-generation', bodyComplete: true });
    expect(onReady).not.toHaveBeenCalled();
    fireEvent.load(frame);
    expect(post.mock.calls.some(([message]) => message.type === 'od:srcdoc-transport-ready-probe' && message.documentId === 'document-1' && message.generation === 'auxiliary-preview')).toBe(true);
    dispatch(frame, { type: 'od:srcdoc-transport-activated', documentId: 'document-1', generation: 'auxiliary-preview', bodyComplete: true });
    dispatch(frame, { type: 'od:srcdoc-transport-activated', documentId: 'document-1', generation: 'auxiliary-preview', bodyComplete: true });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('remounts new content and rejects messages from the previous iframe', () => {
    const onReady = vi.fn();
    const { container, rerender } = render(<PreviewDocumentFrame {...props} onReady={onReady} />);
    const previous = container.querySelector('iframe')!;
    const previousWindow = previous.contentWindow;
    rerender(<PreviewDocumentFrame {...props} srcDoc="<html><body>Updated</body></html>" onReady={onReady} />);
    const frame = container.querySelector('iframe')!;
    expect(frame).not.toBe(previous);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    dispatch(frame, { type: 'od:srcdoc-transport-activated', documentId: 'old', generation: 'auxiliary-preview', bodyComplete: true }, previousWindow);
    expect(onReady).not.toHaveBeenCalled();
    ready(frame, post, 'new');
    expect(post.mock.calls.some(([message]) => message.type === 'od:srcdoc-transport-activate' && message.html.includes('Updated'))).toBe(true);
  });
});
