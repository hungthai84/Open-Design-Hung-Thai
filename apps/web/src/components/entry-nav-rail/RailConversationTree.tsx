import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import type { Conversation, Project } from '../../types';
import { listConversations } from '../../state/projects';
import { useI18n } from '../../i18n';
import { RailRecentRow } from './RailRecentRow';
import styles from './RailConversationTree.module.css';

export interface RailConversationModel {
  projectId: string;
  conversations: Conversation[];
  activeConversationId: string | null;
  creating: boolean;
  newConversationPlacement?: { id: string; afterId: string | null } | null;
  onCreate: () => Promise<void>;
  onSelect: (id: string) => void;
}

export function RailNewConversation({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  return <Button className={styles.create} onClick={onClick} disabled={disabled}>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden>
      <path d="M5 18.89H6.41421L15.7279 9.57627L14.3137 8.16206L5 17.4758V18.89ZM21 20.89H3V16.6473L16.435 3.21231C16.8256 2.82179 17.4587 2.82179 17.8492 3.21231L20.6777 6.04074C21.0682 6.43126 21.0682 7.06443 20.6777 7.45495L9.24264 18.89H21V20.89ZM15.7279 6.74785L17.1421 8.16206L18.5563 6.74785L17.1421 5.33363L15.7279 6.74785Z" />
    </svg>
    <span>{t('entry.newConversation')}</span>
  </Button>;
}

/** Projects are the only folders; their children are conversation leaves. */
export function RailProjectFolder({ project, context, model, onOpenConversation, onRename, onDelete }: {
  project: Project;
  context?: WorkspaceCollabContext | null;
  model?: RailConversationModel | null;
  onOpenConversation?: (projectId: string, conversationId: string) => void | Promise<unknown>;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => Promise<boolean | void> | boolean | void;
}) {
  const { t } = useI18n();
  const current = model?.projectId === project.id ? model : null;
  const [open, setOpen] = useState(Boolean(current));
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (current?.activeConversationId) setOpen(true); }, [current?.activeConversationId]);
  useEffect(() => {
    if (!open || current) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    void listConversations(project.id, { workspaceContext: context, throwOnError: true }).then(list => {
      if (!cancelled) setConversations(list);
    }).catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, Boolean(current), project.id, context, retry]);
  const items = [...(current?.conversations ?? conversations)].sort((a, b) => a.createdAt - b.createdAt);
  const placement = current?.newConversationPlacement;
  if (placement?.afterId && placement.id !== placement.afterId) {
    const addedIndex = items.findIndex(item => item.id === placement.id);
    if (addedIndex >= 0 && items.some(item => item.id === placement.afterId)) {
      const [added] = items.splice(addedIndex, 1);
      if (added) items.splice(items.findIndex(item => item.id === placement.afterId) + 1, 0, added);
    }
  }
  return <>
    <RailRecentRow project={project} workspaceContext={context} expanded={open}
      onOpen={() => { setOpen(value => !value); }} onRename={onRename} onDelete={onDelete} />
    <div className={`accordion-collapsible${open ? ' open' : ''}`} inert={!open} aria-hidden={!open || undefined}>
      <div className="accordion-collapsible-inner">
        <ul className={styles.children}>
          {!current && loading ? <li className={styles.status}>{t('common.loading')}</li> : null}
          {!current && error ? <li><Button className={styles.conversation} onClick={() => setRetry(value => value + 1)}>{t('preview.retry')}</Button></li> : null}
          {(current || !loading && !error) ? items.map(conversation => <li key={conversation.id}>
            <Button className={`${styles.conversation}${current?.activeConversationId === conversation.id ? ` ${styles.selected}` : ''}`}
              aria-current={current?.activeConversationId === conversation.id ? 'page' : undefined}
              onClick={() => current ? current.onSelect(conversation.id) : void onOpenConversation?.(project.id, conversation.id)}>
              <span>{conversation.title || t('chat.untitledConversation')}</span>
            </Button>
          </li>) : null}
        </ul>
      </div>
    </div>
  </>;
}
