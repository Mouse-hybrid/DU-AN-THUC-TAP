import type { KitchenQueueResponse } from "../api/kitchen";
import { parseApiTimestamp } from "../utils/format";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";

export type KdsAction = "start" | "ready" | null;
type KitchenQueueEntry = KitchenQueueResponse[number];

interface KdsTicketProps {
  entry: KitchenQueueEntry;
  stationName: string;
  action: KdsAction;
  busy: boolean;
  canAct: boolean;
  onAction: (entry: KitchenQueueEntry) => void;
}

const SLA_LABELS: Record<string, string> = {
  NORMAL: "Đúng tiến độ",
  DELAYED: "Trễ",
  CRITICAL: "Rất trễ",
};

function temporaryOrderCode(entry: KitchenQueueEntry): string {
  const suffix = entry.order_id.replaceAll("-", "").slice(-4).toUpperCase();
  return `${entry.table_code}-${suffix}`;
}

function waitDuration(entry: KitchenQueueEntry): string {
  const source = entry.item_status === "READY"
    ? entry.done_at
    : entry.status === "QUEUED"
      ? entry.queued_at
      : (entry.started_at ?? entry.queued_at);
  const startedAt = parseApiTimestamp(source);
  if (startedAt === null) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  return minutes < 60 ? `${minutes}p` : `${Math.floor(minutes / 60)}g ${minutes % 60}p`;
}

export function KdsTicket({ entry, stationName, action, busy, canAct, onAction }: KdsTicketProps) {
  const actionLabel = action === "start" ? "Bắt đầu nấu" : "Món xong";

  return (
    <article className="nova-kds-ticket">
      <header className="nova-kds-ticket-header">
        <div>
          <p className="nova-kds-order-code">#{temporaryOrderCode(entry)}</p>
          <strong className="nova-kds-table">Bàn {entry.table_code}</strong>
        </div>
        <StatusBadge status={entry.sla_status} label={SLA_LABELS[entry.sla_status] ?? entry.sla_status} />
      </header>

      <div className="nova-kds-item-copy">
        <h2>{entry.quantity}× {entry.menu_item_name}</h2>
        {entry.note ? <p><strong>Ghi chú:</strong> {entry.note}</p> : <p>Không có ghi chú</p>}
      </div>

      <dl className="nova-kds-meta">
        <div><dt>Trạm</dt><dd>{stationName}</dd></div>
        <div><dt>{entry.item_status === "READY" ? "Đã chờ lấy" : "Thời gian chờ"}</dt><dd>{waitDuration(entry)}</dd></div>
      </dl>

      {action && canAct ? (
        <Button
          variant="primary"
          type="button"
          accessibleLabel={`${actionLabel} ${entry.menu_item_name} bàn ${entry.table_code}`}
          busy={busy}
          busyLabel="Đang cập nhật…"
          onClick={() => onAction(entry)}
        >
          {actionLabel}
        </Button>
      ) : null}
    </article>
  );
}
