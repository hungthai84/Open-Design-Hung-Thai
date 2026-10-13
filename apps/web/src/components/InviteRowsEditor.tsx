// The invite form's recipient block — column labels, one email + role row per
// invitee, and "add member". Shared by InviteDialog and the seat-free
// onboarding invite step (DEV-ONLY mock) so both offer the same role picker.
//
// The wrapper is `display: contents`, so the labels / rows / add button stay
// direct flex items of whatever form column hosts them.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useI18n } from '../i18n';

export const INVITE_ROLE_OPTIONS = ['admin', 'member'] as const;

// Default invited role, aligned to the PRD matrix (admin/member are assignable;
// owner is the workspace creator only and never assignable).
export const DEFAULT_INVITE_ROLE = 'member';

// Vertical gap between the role trigger and its menu (was the CSS
// `top: calc(100% + var(--spacing-6))` before the menu moved to a portal).
const ROLE_MENU_GAP = 6;

export interface InviteRow {
  email: string;
  role: string;
}

export type InviteRowsEditorEvent = 'role_select' | 'add_recipient_row' | 'remove_recipient_row';

// Demo-grade email shape check (something@something.tld).
export const isInviteEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

// 'pending' only ever comes back from a send (the address already holds an
// invite nobody has accepted yet); the client cannot know it up front.
export type InviteRowError = 'invalid' | 'duplicate' | 'member' | 'pending';

/**
 * Per-row problem, or null. Empty rows are never an error (they are skipped on
 * send); a repeated email is flagged on its second and later rows only.
 */
export function inviteRowErrors(
  rows: InviteRow[],
  memberEmails: readonly string[] = [],
): Array<InviteRowError | null> {
  const members = new Set(memberEmails.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  return rows.map((row) => {
    const email = row.email.trim().toLowerCase();
    if (!email) return null;
    if (!isInviteEmail(email)) return 'invalid';
    if (seen.has(email)) return 'duplicate';
    seen.add(email);
    return members.has(email) ? 'member' : null;
  });
}

/** True when every row is blank — the only time "send" stays disabled. */
export const inviteRowsEmpty = (rows: InviteRow[]) => rows.every((row) => !row.email.trim());

const ROW_ERROR_KEY = {
  invalid: 'seatFree.emailInvalid',
  duplicate: 'seatFree.emailDuplicate',
  member: 'seatFree.emailAlreadyMember',
  pending: 'seatFree.emailPendingInvite',
} as const;

function roleLabel(role: string, t: ReturnType<typeof useI18n>['t']) {
  return role === 'admin' ? t('invite.role.admin') : t('invite.role.member');
}

interface Props {
  rows: InviteRow[];
  onRowsChange: (rows: InviteRow[]) => void;
  /** Owner / Admin can choose roles; Member invites with the default role. */
  canAssignRoles?: boolean;
  /** Rendered at the end of the "add member" line (e.g. copy invite link). */
  addRowAside?: ReactNode;
  /** Extra class on the wrapper, for host-specific styling hooks. */
  className?: string;
  /** One-line explanation under each role option in the menu; omit for none. */
  describeRole?: (role: string) => string | null;
  /**
   * Inline email validation (seat-free mock). Errors stay quiet while typing:
   * a row is checked once it loses focus, then re-checked on every keystroke
   * so a fix clears at once. Each send attempt bumps `submitCount`, which
   * reveals every row's error (including "already a member", which waits for
   * send) and focuses the first bad row.
   */
  validation?: {
    submitCount: number;
    memberEmails?: readonly string[];
    /**
     * Per-address failures a send came back with (lowercased email → reason).
     * Shown at once on the row holding that address; editing the address
     * clears it.
     */
    sendErrors?: Readonly<Record<string, InviteRowError>>;
  };
  /** Fired on the editor's own interactions, for the host's analytics. */
  onEvent?: (event: InviteRowsEditorEvent) => void;
}

export function InviteRowsEditor({
  rows,
  onRowsChange,
  canAssignRoles = true,
  addRowAside,
  className,
  describeRole,
  validation,
  onEvent,
}: Props) {
  const { t } = useI18n();
  const [openRoleIndex, setOpenRoleIndex] = useState<number | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const roleTriggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const roleMenuRef = useRef<HTMLDivElement | null>(null);
  const [roleMenuPos, setRoleMenuPos] = useState<CSSProperties | null>(null);
  const roleListboxId = useId();
  const errorIdBase = useId();
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  // Rows that have been left at least once with something typed in them.
  const [touched, setTouched] = useState<boolean[]>(() => rows.map(() => false));
  const submitted = (validation?.submitCount ?? 0) > 0;
  const errors = validation ? inviteRowErrors(rows, validation.memberEmails) : [];
  const shownError = (i: number): InviteRowError | null => {
    const sendError = validation?.sendErrors?.[rows[i]?.email.trim().toLowerCase() ?? ''];
    const error = errors[i] ?? sendError ?? null;
    if (!error) return null;
    if (error === sendError) return error;
    if (error === 'member') return submitted ? error : null;
    return submitted || touched[i] ? error : null;
  };

  // Each send attempt: jump to the first row that needs fixing.
  useEffect(() => {
    if (!validation || validation.submitCount === 0) return;
    const sendErrors = validation.sendErrors ?? {};
    const first = inviteRowErrors(rows, validation.memberEmails).findIndex(
      (error, i) => error || sendErrors[rows[i]?.email.trim().toLowerCase() ?? ''],
    );
    if (first >= 0) inputRefs.current[first]?.focus();
    // Only a new attempt should move focus, not edits in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validation?.submitCount]);

  // The rows list is a scroll container (`overflow-y: auto`), which clips any
  // in-flow descendant to its box — a dropdown rendered inside it can never
  // extend past the row. The role menu therefore lives in a portal on <body>,
  // anchored to its trigger's viewport rect; re-anchor on resize and on any
  // scroll (capture phase covers the rows container itself). Same pattern as
  // ComposerModePicker.
  useLayoutEffect(() => {
    if (openRoleIndex === null) {
      setRoleMenuPos(null);
      return;
    }
    const update = () => {
      const rect = roleTriggerRefs.current[openRoleIndex]?.getBoundingClientRect();
      if (!rect) return;
      // Right-aligned to the trigger so a menu wider than it (role
      // descriptions) grows leftward over the email field, not off the form.
      setRoleMenuPos({
        right: window.innerWidth - rect.right,
        top: rect.bottom + ROLE_MENU_GAP,
        minWidth: rect.width,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [openRoleIndex]);

  useEffect(() => {
    if (openRoleIndex === null) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      // The menu is portaled outside the rows container, so it must count as
      // "inside" here — otherwise this dismisser unmounts an option on
      // mousedown before its click can land.
      if (rowsRef.current?.contains(target)) return;
      if (roleMenuRef.current?.contains(target)) return;
      setOpenRoleIndex(null);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [openRoleIndex]);

  function updateRow(index: number, patch: Partial<InviteRow>) {
    onRowsChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    onEvent?.('add_recipient_row');
    setTouched((prev) => [...prev, false]);
    onRowsChange([...rows, { email: '', role: DEFAULT_INVITE_ROLE }]);
  }
  function removeRow(index: number) {
    onEvent?.('remove_recipient_row');
    if (rows.length <= 1) return;
    setTouched((prev) => prev.filter((_, i) => i !== index));
    onRowsChange(rows.filter((_, i) => i !== index));
  }
  function markTouched(index: number) {
    if (!validation || !rows[index]?.email.trim() || touched[index]) return;
    setTouched((prev) => prev.map((value, i) => (i === index ? true : value)));
  }

  return (
    <div className={`entry-invite__editor${className ? ` ${className}` : ''}`}>
      <div className={`entry-invite__field-labels${rows.length > 1 ? ' entry-invite__field-labels--remove' : ''}`}>
        <span className="entry-invite__label">{t('workspaceInvite.emailLabel')}</span>
        <span className="entry-invite__label entry-invite__label--role">
          {canAssignRoles ? t('workspaceInvite.roleLabel') : t('workspaceInvite.defaultRoleLabel')}
        </span>
      </div>
      <div className="entry-invite__rows" ref={rowsRef}>
        {rows.map((row, i) => {
          const error = shownError(i);
          const errorId = `${errorIdBase}-${i}`;
          return (
          <div className="entry-invite__recipient" key={i}>
          <div className="entry-invite__fields">
            <input
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              className={`entry-invite__input${error ? ' entry-invite__input--error' : ''}`}
              type="email"
              placeholder={t('workspaceInvite.emailPlaceholder')}
              value={row.email}
              onChange={(e) => updateRow(i, { email: e.target.value })}
              onBlur={() => markTouched(i)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            <div className="entry-invite__role-picker">
              <button
                type="button"
                ref={(el) => {
                  roleTriggerRefs.current[i] = el;
                }}
                className="entry-invite__role"
                onClick={() => {
                  if (!canAssignRoles) return;
                  onEvent?.('role_select');
                  setOpenRoleIndex((current) => (current === i ? null : i));
                }}
                disabled={!canAssignRoles}
                aria-label={canAssignRoles ? t('workspaceInvite.roleLabel') : t('workspaceInvite.defaultRoleLabel')}
                aria-haspopup="listbox"
                aria-expanded={openRoleIndex === i}
                aria-controls={`${roleListboxId}-${i}`}
              >
                <span>{roleLabel(canAssignRoles ? row.role : DEFAULT_INVITE_ROLE, t)}</span>
                <Icon name="chevron-down" size={16} />
              </button>
              {openRoleIndex === i && roleMenuPos && typeof document !== 'undefined'
                ? createPortal(
                    <div
                      ref={roleMenuRef}
                      className={`entry-invite__role-menu${describeRole ? ' entry-invite__role-menu--described' : ''}`}
                      id={`${roleListboxId}-${i}`}
                      role="listbox"
                      style={roleMenuPos}
                    >
                      {INVITE_ROLE_OPTIONS.map((role) => (
                        <button
                          type="button"
                          key={role}
                          className={`entry-invite__role-option${(canAssignRoles ? row.role : DEFAULT_INVITE_ROLE) === role ? ' is-selected' : ''}`}
                          role="option"
                          aria-selected={(canAssignRoles ? row.role : DEFAULT_INVITE_ROLE) === role}
                          onClick={() => {
                            updateRow(i, { role });
                            setOpenRoleIndex(null);
                          }}
                        >
                          <span className="entry-invite__role-option-text">
                            <span>{roleLabel(role, t)}</span>
                            {describeRole?.(role) ? (
                              <span className="entry-invite__role-option-desc">{describeRole(role)}</span>
                            ) : null}
                          </span>
                          {(canAssignRoles ? row.role : DEFAULT_INVITE_ROLE) === role ? <Icon name="check" size={16} /> : null}
                        </button>
                      ))}
                    </div>,
                    document.body,
                  )
                : null}
            </div>
            {rows.length > 1 ? (
              <button
                type="button"
                className="entry-invite__row-remove"
                onClick={() => removeRow(i)}
                aria-label={t('workspaceInvite.removeRow')}
              >
                <Icon name="close" size={15} />
              </button>
            ) : null}
          </div>
          {error ? (
            <p className="entry-invite__row-error" id={errorId} role="alert">
              {t(ROW_ERROR_KEY[error])}
            </p>
          ) : null}
          </div>
          );
        })}
      </div>
      <div className="entry-invite__add-row-line">
        <button type="button" className="entry-invite__add-row" onClick={addRow}>
          <Icon name="plus" size={14} /> {t('workspaceInvite.addMember')}
        </button>
        {addRowAside}
      </div>
    </div>
  );
}
