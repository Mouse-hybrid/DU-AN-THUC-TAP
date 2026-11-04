import { Link } from "react-router-dom";
import type { KitchenQueueResponse } from "../api/kitchen";
import { parseApiTimestamp } from "../utils/format";
import { SLA_LABELS, ticketCode } from "../utils/kds";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { MenuThumb } from "./MenuThumb";
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

function formatMinutes(minutes: number): string {
  return minutes < 60 ? `${minutes}p` : `${Math.floor(minutes / 60)}g ${minutes % 60}p`;
}

function waitDuration(entry: KitchenQueueEntry): string {
  // Món đang nấu: ưu tiên số phút do API tính (cùng nguồn với sla_status).
  if (entry.item_status !== "READY" && entry.status === "IN_PROGRESS" && typeof entry.elapsed_minutes === "number") {
    return formatMinutes(Math.max(0, Math.floor(entry.elapsed_minutes)));
  }
  const source = entry.item_status === "READY"
    ? entry.done_at
    : entry.status === "QUEUED"
      ? entry.queued_at
      : (entry.started_at ?? entry.queued_at);
  const startedAt = parseApiTimestamp(source);
  if (startedAt === null) return "—";
  return formatMinutes(Math.max(0, Math.floor((Date.now() - startedAt) / 60_000)));
}

export function KdsTicket({ entry, stationName, action, busy, canAct, onAction }: KdsTicketProps) {
  const actionLabel = action === "start" ? "Bắt đầu nấu" : "Món xong";

  const waited = waitDuration(entry);
  return (
    <article className={`nova-kds-ticket nova-kds-ticket--${entry.sla_status.toLowerCase()}`}>
      <header className="nova-kds-ticket-header">
        <div className="nova-kds-ticket-id">
          <strong className="nova-kds-table"><span className="nova-visually-hidden">Bàn </span>{entry.table_code}</strong>
          <span className="nova-kds-order-code">#{ticketCode(entry.table_code, entry.order_id)}</span>
        </div>
        <div className="nova-kds-ticket-status">
          <StatusBadge status={entry.sla_status} label={SLA_LABELS[entry.sla_status] ?? entry.sla_status} />
          <span className="nova-kds-timer">
            <Icon name="clock" />
            <span className="nova-visually-hidden">{entry.item_status === "READY" ? "Đã chờ lấy " : "Thời gian chờ "}</span>
            {waited}
          </span>
        </div>
      </header>

      <div className="nova-kds-item">
        <MenuThumb name={entry.menu_item_name} className="nova-kds-thumb" />
        <div className="nova-kds-item-copy">
          <h2>{entry.quantity}× {entry.menu_item_name}</h2>
          {entry.note ? <p className="nova-kds-note"><strong>Ghi chú:</strong> {entry.note}</p> : null}
        </div>
      </div>

      <div className="nova-kds-ticket-footer">
        <p className="nova-kds-station">Trạm: {stationName}</p>
        <Link
          className="nova-kds-detail-link"
          to={`/kitchen/orders/${encodeURIComponent(entry.order_id)}/items/${encodeURIComponent(entry.order_item_id)}`}
          aria-label={`Chi tiết ${entry.menu_item_name} bàn ${entry.table_code}`}
        >
          Chi tiết
          <Icon name="chevron-right" />
        </Link>
      </div>

      {action && canAct ? (
        <Button
          variant="primary"
          type="button"
          className="nova-kds-action"
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
