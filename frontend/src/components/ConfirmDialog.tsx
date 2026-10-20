import type { ReactNode } from "react";
import { Button } from "./Button";

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <div className="nova-dialog-backdrop" role="presentation">
      <section className="nova-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="nova-confirm-title">
        <h2 id="nova-confirm-title">{title}</h2>
        <div>{children}</div>
        <div className="nova-confirm-actions">
          <Button variant="secondary" type="button" accessibleLabel="Hủy thao tác" disabled={busy} onClick={onCancel}>Hủy</Button>
          <Button variant="primary" type="button" accessibleLabel={confirmLabel} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </section>
    </div>
  );
}
