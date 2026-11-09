import { useEffect, type FormEvent, type ReactNode } from "react";
import { Button } from "./Button";

interface FormDialogProps {
  title: string;
  titleId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
  submitVariant?: "primary" | "danger";
  children: ReactNode;
  error?: string;
  wide?: boolean;
}

/** Khung hộp thoại có form dùng chung (Esc để đóng, chặn bấm lặp khi đang gửi). */
export function FormDialog({
  title,
  titleId,
  busy,
  onCancel,
  onSubmit,
  submitLabel,
  submitDisabled = false,
  submitVariant = "primary",
  children,
  error = "",
  wide = false,
}: FormDialogProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && !submitDisabled) onSubmit();
  }

  return (
    <div className="nova-dialog-backdrop" role="presentation">
      <form
        className={`nova-confirm-dialog nova-form-dialog${wide ? " nova-form-dialog--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        noValidate
      >
        <h2 id={titleId}>{title}</h2>
        <div className="nova-form-dialog-body">{children}</div>
        {error ? <div className="nova-alert" role="alert">{error}</div> : null}
        <div className="nova-confirm-actions">
          <Button variant="secondary" type="button" accessibleLabel="Hủy thao tác" disabled={busy} onClick={onCancel}>Hủy</Button>
          <Button variant={submitVariant} type="submit" accessibleLabel={submitLabel} busy={busy} disabled={submitDisabled}>{submitLabel}</Button>
        </div>
      </form>
    </div>
  );
}
