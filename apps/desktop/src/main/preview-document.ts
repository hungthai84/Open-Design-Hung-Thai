import type { BrowserWindow } from 'electron';
import { buildPreviewBaseHrefBridge } from '@open-design/contracts/runtime/preview-observability';
import { findRealTagEnd, HTML_TAG_PATTERNS, prependAfterDoctype } from '@open-design/contracts/runtime/html-injection-points';

/** Activate the selected export snapshot at its bound file URL. Hash changes
 * stay in this document, including when exporting a historical version. */
export async function writePreviewDocument(
  window: BrowserWindow,
  html: string,
  documentUrl: string,
  baseHref: string,
): Promise<void> {
  const bridge = buildPreviewBaseHrefBridge({ href: baseHref, documentUrl, expiresAt: 0 });
  const headEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.headOpen);
  const htmlEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.htmlOpen);
  const document = headEnd >= 0
    ? html.slice(0, headEnd) + bridge + html.slice(headEnd)
    : htmlEnd >= 0
      ? html.slice(0, htmlEnd) + '<head>' + bridge + '</head>' + html.slice(htmlEnd)
      : prependAfterDoctype(html, bridge);
  // HTML is an IPC input, never executable interpolation. JSON encoding keeps
  // authored quotes/backticks inside the document.write string argument.
  await window.webContents.executeJavaScript(`new Promise(function(resolve, reject) {
    document.open();
    var timeout = setTimeout(function(){ reject(new Error('Preview document parse timed out')); }, 15000);
    document.addEventListener('DOMContentLoaded', function(){ clearTimeout(timeout); resolve(); }, { once: true });
    document.write(${JSON.stringify(document)});
    document.close();
  });`);
}
