import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type IframeHTMLAttributes } from 'react';

interface Props extends IframeHTMLAttributes<HTMLIFrameElement> {
  srcDoc: string;
  documentUrl?: string;
  generation?: string;
  onReady?: () => void;
}

/** The thumbnail/presentation counterpart of FileViewer's enhanced transport. */
export const PreviewDocumentFrame = forwardRef<HTMLIFrameElement, Props>(function PreviewDocumentFrame({
  srcDoc, documentUrl, generation = 'auxiliary-preview', onReady, onLoad, ...props
}, forwardedRef) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sequence = useRef(0);
  const probeSequence = useRef(0);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const loadedDocument = useRef<((frame: HTMLIFrameElement) => void) | null>(null);
  // A changed auxiliary document gets a fresh JS realm. Rewriting an already
  // running document can collide with its top-level lexical declarations.
  const revision = useMemo(() => ++sequence.current, [srcDoc, documentUrl, generation]);
  useImperativeHandle(forwardedRef, () => frameRef.current!, [revision]);
  useEffect(() => {
    if (!documentUrl) return;
    const frame = frameRef.current;
    let documentId: string | null = null;
    let completedDocumentId: string | null = null;
    let probeId: string | null = null;
    let probeCandidate: string | null = null;
    const retiredDocuments = new Set<string>();
    const challenge = (candidate: string | null) => {
      probeCandidate = candidate;
      probeId = `auxiliary-shell-${++probeSequence.current}`;
      frame?.contentWindow?.postMessage({ type: 'od:srcdoc-transport-shell-probe', probeId }, '*');
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame?.contentWindow) return;
      const data = event.data;
      if (data?.type === 'od:srcdoc-transport-ready') {
        if (typeof data.documentId !== 'string' || !data.documentId || retiredDocuments.has(data.documentId)) return;
        if (data.documentId === documentId) {
          if (data.probeId === probeId) probeId = null;
          return;
        }
        // WindowProxy survives navigation. Challenge the current shell rather
        // than adopt a queued ready message from the document it replaced.
        if (!probeId || data.probeId !== probeId) {
          if (!probeId || probeCandidate !== data.documentId) challenge(data.documentId);
          return;
        }
        if (documentId) retiredDocuments.add(documentId);
        documentId = data.documentId;
        probeId = null;
        frame?.contentWindow?.postMessage({ type: 'od:srcdoc-transport-activate', html: srcDoc, generation, documentId }, '*');
      }
      if (data?.type === 'od:srcdoc-transport-activated'
        && documentId && data.documentId === documentId && data.generation === generation
        && data.bodyComplete === true && completedDocumentId !== documentId) {
        completedDocumentId = documentId;
        readyCallback.current?.();
      }
    };
    const onDocumentLoad = (target: HTMLIFrameElement) => {
      if (target !== frame) return;
      challenge(null);
      if (documentId) target.contentWindow?.postMessage({
        type: 'od:srcdoc-transport-ready-probe', generation, documentId,
        probeId: `auxiliary-load-${++probeSequence.current}`,
      }, '*');
    };
    loadedDocument.current = onDocumentLoad;
    window.addEventListener('message', receive);
    challenge(null);
    return () => {
      window.removeEventListener('message', receive);
      if (loadedDocument.current === onDocumentLoad) loadedDocument.current = null;
    };
  }, [documentUrl, srcDoc, generation]);
  return <iframe {...props} key={revision} ref={frameRef}
    src={documentUrl} srcDoc={documentUrl ? undefined : srcDoc}
    onLoad={(event) => {
      if (documentUrl) {
        loadedDocument.current?.(event.currentTarget);
      }
      else { onLoad?.(event); onReady?.(); }
    }} />;
});
