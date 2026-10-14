import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../../i18n';
import styles from './WorkspaceComposerDock.module.css';

/** Resize both floating chat layers from their shared top edge. */
export function WorkspaceConversationResizeHandle({ height, maxHeight, minHeight, onResize }: {
  height: number;
  maxHeight: number;
  minHeight: number;
  onResize: (height: number) => void;
}) {
  const t = useT();
  const drag = useRef<{ id: number; y: number; height: number } | null>(null);
  const restoreBody = useRef<(() => void) | null>(null);
  const finish = () => {
    drag.current = null;
    restoreBody.current?.();
    restoreBody.current = null;
  };
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('blur', finish);
      finish();
    };
  }, []);
  const resize = (value: number) => onResize(Math.min(maxHeight, Math.max(minHeight, value)));
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    resize(drag.current.height + drag.current.y - event.clientY);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowUp' ? height + 24
      : event.key === 'ArrowDown' ? height - 24
        : event.key === 'Home' ? minHeight : event.key === 'End' ? maxHeight : null;
    if (next === null) return;
    event.preventDefault();
    resize(next);
  };
  return <div className={styles.resizeHandle} role="separator" tabIndex={0}
    aria-orientation="horizontal" aria-label={t('project.resizeChatPanel')}
    aria-valuemin={Math.round(minHeight)} aria-valuemax={Math.round(maxHeight)}
    aria-valuenow={Math.round(height)} data-testid="workspace-conversation-resize"
    onKeyDown={keyDown}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, y: event.clientY, height };
      const { cursor, userSelect } = document.body.style;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      restoreBody.current = () => {
        document.body.style.cursor = cursor;
        document.body.style.userSelect = userSelect;
      };
    }}
    onPointerMove={move}
    onPointerUp={event => {
      if (!drag.current || drag.current.id !== event.pointerId) return;
      move(event);
      finish();
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={finish} onLostPointerCapture={finish}
  />;
}
