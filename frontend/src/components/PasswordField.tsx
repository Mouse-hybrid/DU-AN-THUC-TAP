import { useState } from "react";
import { Icon } from "./Icon";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  error?: string;
  hint?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** Ô mật khẩu có nút hiện/ẩn, dùng cho tạo nhân viên, đặt lại và đổi mật khẩu. */
export function PasswordField({ id, label, value, onChange, autoComplete, error, hint, disabled = false, autoFocus = false }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="nova-field">
      <label htmlFor={id}>{label}</label>
      <div className="nova-password-wrap">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="nova-icon-button"
          type="button"
          aria-label={visible ? `Ẩn ${label.toLowerCase()}` : `Hiện ${label.toLowerCase()}`}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          <Icon name={visible ? "eye-off" : "eye"} />
        </button>
      </div>
      {error ? <p id={`${id}-error`} className="nova-field-error">{error}</p> : hint ? <p id={`${id}-hint`} className="nova-field-hint">{hint}</p> : null}
    </div>
  );
}
