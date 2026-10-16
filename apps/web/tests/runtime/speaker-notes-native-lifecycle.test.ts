import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSpeakerNotesPresenterHtml } from '../../src/runtime/speaker-notes';

const labels = { title: 'Notes', edit: 'Edit', save: 'Save', pause: 'Pause', resume: 'Resume', reset: 'Reset', previous: 'Previous', next: 'Next', empty: 'Empty', slide: '{current}/{total}' };
const documentUrl = (scope: string) => `http://localhost/api/projects/p/preview/${scope}/deck.html`;
const documents = (scope: string) => [0, 1, 2].map(index => `<html><body><h1>${scope}:slide-${index}</h1><script data-scope="${scope}"></script></body></html>`);

function presenter(initialSlideIndex = 1) {
  const opener = new JSDOM('', { url: 'http://localhost/' });
  const dom = new JSDOM(buildSpeakerNotesPresenterHtml({
    previewHtml: documents('scope111')[0]!, previewHtmlBySlide: documents('scope111'), previewDocumentUrl: documentUrl('scope111'), labels, title: 'Deck', projectId: 'p', fileName: 'deck.html', notes: [], initialSlideIndex, slideCount: 3,
  }), { url: 'http://localhost/presenter', runScripts: 'dangerously', beforeParse(window) { window.resizeTo = () => {}; Object.defineProperty(window, 'opener', { value: opener.window }); } });
  const frames = Object.fromEntries(['current', 'previous', 'next'].map(id => [id, dom.window.document.getElementById(id) as HTMLIFrameElement]));
  const posts = Object.fromEntries(Object.entries(frames).map(([id, frame]) => [id, vi.spyOn(frame.contentWindow!, 'postMessage')]));
  const observedWindows = Object.fromEntries(Object.entries(frames).map(([id, frame]) => [id, frame.contentWindow]));
  function send(data: Record<string, unknown>, source: unknown = opener.window) {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: source as Window }));
  }
  function ready(id: string, documentId: string) {
    const frame = frames[id]!;
    // JSDOM replaces contentWindow on src assignment; browsers retain the
    // WindowProxy. Observe the new mock document after a navigation.
    if (observedWindows[id] !== frame.contentWindow) {
      observedWindows[id] = frame.contentWindow;
      posts[id] = vi.spyOn(frame.contentWindow!, 'postMessage');
    }
    send({ type: 'od:srcdoc-transport-ready', documentId }, frame.contentWindow);
    const probe = posts[id]!.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-shell-probe').at(-1)?.[0];
    send({ type: 'od:srcdoc-transport-ready', documentId, probeId: probe?.probeId }, frame.contentWindow);
  }
  function update(scope: string) {
    send({ type: 'od:presenter-preview-update', projectId: 'p', fileName: 'deck.html', previewDocumentUrl: documentUrl(scope), previewHtml: documents(scope)[0], previewHtmlBySlide: documents(scope) });
  }
  function go(active: number) { send({ type: 'od:presenter-slide-state', projectId: 'p', fileName: 'deck.html', active, count: 3, notes: [] }); }
  return { dom, frames, posts, send, ready, update, go, close: () => { dom.window.close(); opener.window.close(); } };
}

describe('native presenter recovery (OPEND-3782)', () => {
  it('reactivates current/previous/next across two replacement scopes with fresh scope metadata', () => {
    const app = presenter();
    try {
      for (const id of Object.keys(app.frames)) app.ready(id, `${id}-document-1`);
      for (const scope of ['scope222', 'scope333']) {
        app.update(scope);
        for (const id of Object.keys(app.frames)) {
          expect(app.frames[id]!.src).toBe(documentUrl(scope));
          app.ready(id, `${id}-${scope}`);
          const activation = app.posts[id]!.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-activate').at(-1)?.[0];
          expect(activation?.html).toContain(`data-scope="${scope}"`);
          expect(activation?.documentId).toBe(`${id}-${scope}`);
        }
      }
    } finally { app.close(); }
  });

  it.each([{ initial: 0, later: 1, frame: 'previous' }, { initial: 2, later: 1, frame: 'next' }])('uses the latest scope when $frame first becomes visible', ({ initial, later, frame }) => {
    const app = presenter(initial);
    try {
      expect(app.frames[frame]!.getAttribute('src')).toBeNull();
      app.update('scope222');
      app.update('scope333');
      app.go(later);
      expect(app.frames[frame]!.src).toBe(documentUrl('scope333'));
      app.ready(frame, 'new-document');
      const activation = app.posts[frame]!.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-activate').at(-1)?.[0];
      expect(activation?.html).toContain('scope333');
    } finally { app.close(); }
  });

  it('waits for matching complete content and then navigates to the latest wanted slide', () => {
    const app = presenter(0);
    try {
      app.ready('current', 'document-1');
      app.go(1);
      const post = app.posts.current!;
      app.frames.current!.dispatchEvent(new app.dom.window.Event('load'));
      expect(post.mock.calls.some(([message]) => message.type === 'od:slide')).toBe(false);
      for (const data of [
        { documentId: 'document-1', generation: 'auxiliary-preview', bodyComplete: false },
        { documentId: 'old-document', generation: 'auxiliary-preview', bodyComplete: true },
        { documentId: 'document-1', generation: 'old-generation', bodyComplete: true },
      ]) app.send({ type: 'od:srcdoc-transport-activated', ...data }, app.frames.current!.contentWindow);
      expect(post.mock.calls.some(([message]) => message.type === 'od:slide')).toBe(false);
      app.send({ type: 'od:srcdoc-transport-activated', documentId: 'document-1', generation: 'auxiliary-preview', bodyComplete: true }, app.frames.current!.contentWindow);
      expect(post.mock.calls.some(([message]) => message.type === 'od:slide' && message.index === 1)).toBe(true);
    } finally { app.close(); }
  });

  it('reactivates a same-URL reload once and ignores retired document messages', () => {
    const app = presenter(0);
    try {
      app.ready('current', 'document-1');
      app.go(2);
      app.ready('current', 'document-2');
      app.ready('current', 'document-2');
      app.ready('current', 'document-1');
      const post = app.posts.current!;
      const activations = post.mock.calls.filter(([message]) => message.type === 'od:srcdoc-transport-activate').map(([message]) => message);
      expect(activations.map(message => message.documentId)).toEqual(['document-1', 'document-2']);
      expect(activations[1].html).toContain('slide-2');
      app.send({ type: 'od:srcdoc-transport-activated', documentId: 'document-1', generation: 'auxiliary-preview', bodyComplete: true }, app.frames.current!.contentWindow);
      expect(post.mock.calls.some(([message]) => message.type === 'od:slide')).toBe(false);
      app.send({ type: 'od:srcdoc-transport-activated', documentId: 'document-2', generation: 'auxiliary-preview', bodyComplete: true }, app.frames.current!.contentWindow);
      expect(post.mock.calls.some(([message]) => message.type === 'od:slide' && message.index === 2)).toBe(true);
    } finally { app.close(); }
  });

  it('ignores preview replacements from another window or file', () => {
    const app = presenter(0);
    try {
      const replacement = { type: 'od:presenter-preview-update', projectId: 'p', fileName: 'deck.html', previewDocumentUrl: documentUrl('scope222'), previewHtmlBySlide: documents('scope222') };
      app.send(replacement, app.frames.current!.contentWindow);
      app.send({ ...replacement, fileName: 'other.html' });
      expect(app.frames.current!.src).toBe(documentUrl('scope111'));
      app.go(1);
      expect(app.frames.previous!.src).toBe(documentUrl('scope111'));
    } finally { app.close(); }
  });
});
