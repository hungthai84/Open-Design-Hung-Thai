import { useCallback, useEffect, useRef } from 'react';

/** The transcript, composer and portaled position menu are one focus region. */
export function useWorkspaceConversationFocus(
  owner: string,
  expanded: boolean,
  onExpandedChange?: (expanded: boolean) => void,
) {
  // React portals keep their logical parent even when their DOM leaves the
  // floating card. Composer attachment/model menus still belong to this chat.
  const internalEvents = useRef(new WeakSet<Event>());
  const markInteraction = useCallback((event: Event) => {
    internalEvents.current.add(event);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const dismissOutside = (event: Event) => {
      if (internalEvents.current.has(event)) return;
      const target = event.target;
      if (target instanceof Element
        && target.closest('[data-workspace-conversation-owner]')
          ?.getAttribute('data-workspace-conversation-owner') === owner) return;
      onExpandedChange?.(false);
    };
    const dismiss = () => onExpandedChange?.(false);
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      window.removeEventListener('blur', dismiss);
    };
  }, [owner, expanded, onExpandedChange]);
  return markInteraction;
}
