import { getStatusMeta } from "./status";

interface StatusBadgeProps {
  status: string;
  label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const meta = getStatusMeta(status);
  return (
    <span className={`nova-status-badge nova-status--${meta.className}`}>
      {label ?? meta.label}
    </span>
  );
}
