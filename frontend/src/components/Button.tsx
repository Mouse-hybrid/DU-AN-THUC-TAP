import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  variant: "primary" | "secondary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  accessibleLabel: string;
  busyLabel?: string;
  children: ReactNode;
}

export function Button({
  variant,
  busy = false,
  disabled = false,
  accessibleLabel,
  busyLabel = "Đang xử lý…",
  children,
  className = "",
  ...buttonProps
}: ButtonProps) {
  const classes = `nova-button nova-button--${variant}${className ? ` ${className}` : ""}`;

  return (
    <button
      {...buttonProps}
      className={classes}
      disabled={disabled || busy}
      aria-label={accessibleLabel}
      aria-busy={busy}
    >
      {busy ? <span className="nova-spinner" aria-hidden="true" /> : null}
      <span>{busy ? busyLabel : children}</span>
    </button>
  );
}
