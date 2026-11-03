import { Icon } from "./Icon";

interface StateCardProps {
  kind: "loading" | "empty" | "error";
  title: string;
  message: string;
  onRetry?: () => void;
  actionLabel?: string;
  onAction?: () => void;
}

export function StateCard({ kind, title, message, onRetry, actionLabel, onAction }: StateCardProps) {
  return (
    <section className={`nova-state-card${kind === "error" ? " nova-state-card--error" : ""}`} aria-live="polite">
      {kind === "loading" ? <span className="nova-spinner nova-spinner--large" aria-hidden="true" /> : null}
      {kind === "error" ? <Icon name="alert-circle" className="nova-state-icon nova-icon" /> : null}
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry ? (
        <button className={`nova-button nova-button--${kind === "error" ? "primary" : "secondary"}`} type="button" onClick={onRetry}>
          Thử lại
        </button>
      ) : null}
      {onAction && actionLabel ? (
        <button className="nova-button nova-button--secondary" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}
