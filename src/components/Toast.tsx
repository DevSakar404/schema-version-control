'use client';

/**
 * A floating error notification, fixed to the viewport corner.
 *
 * Exists specifically because an inline `role="alert"` span next to a form's
 * submit button reflows everything below it the moment the message is more
 * than a few words — a duplicate-branch-name error, or a "this branch moved"
 * message with an action button, both wrap to two lines and visibly push the
 * page content down. `position: fixed` makes that structurally impossible:
 * the toast is never part of document flow, so nothing else on the page can
 * ever move because of it.
 *
 * Deliberately not a global toast queue/provider. All three current call
 * sites (NewBranchForm, SchemaTree, MergeBoard) are independent client
 * components on different pages, each surfacing at most one error of its own
 * at a time — there's no case here where two toasts need to stack, so a
 * shared context would be complexity with nothing to coordinate.
 */

export function Toast({
  message,
  action,
  onDismiss,
}: {
  message: string;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
}) {
  return (
    <div className="toast" role="alert">
      <span>{message}</span>
      {action && (
        <button type="button" className="btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <button type="button" className="toast-dismiss" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
