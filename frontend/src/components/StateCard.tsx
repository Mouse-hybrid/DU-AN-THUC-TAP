import { Icon } from "./Icon";

interface StateCardProps {
  kind: "loading" | "empty" | "error";
  title: string;
  message: string;
  onRetry?: () => void;
}

export function StateCard({ kind, title, message, onRetry }: StateCardProps) {
  return (
    <section className={`nova-state-card${kind === "error" ? " nova-state-card--error" : ""}`} aria-live="polite">
      {kind === "loading" ? <span className="nova-spinner nova-spinner--large" aria-hidden="true" /> : null}
      {kind === "error" ? <Icon name="alert-circle" className="nova-state-icon nova-icon" /> : null}
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry ? (
        <button className="nova-button nova-button--secondary" type="button" onClick={onRetry}>
          Thử lại
        </button>
      ) : null}
    </section>
  );
}
