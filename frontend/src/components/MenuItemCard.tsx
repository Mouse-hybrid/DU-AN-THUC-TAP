import type { components } from "../api/schema";
import { formatVnd } from "../utils/format";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";

type MenuItem = components["schemas"]["MenuItemOut"];

interface MenuItemCardProps {
  item: MenuItem;
  busy?: boolean;
  disabled?: boolean;
  showAddAction?: boolean;
  onAdd: (item: MenuItem) => void;
}

export function MenuItemCard({ item, busy = false, disabled = false, showAddAction = true, onAdd }: MenuItemCardProps) {
  const unavailable = !item.is_available;
  return (
    <article className={`nova-menu-card${unavailable ? " nova-menu-card--unavailable" : ""}`}>
      <div className="nova-menu-card-copy">
        <h3>{item.name}</h3>
        <strong>{formatVnd(item.price)}</strong>
      </div>
      {unavailable ? <StatusBadge status="UNAVAILABLE" label="Hết món" /> : null}
      {showAddAction ? (
        <Button
          variant="secondary"
          type="button"
          accessibleLabel={`Thêm ${item.name} vào đơn`}
          busy={busy}
          busyLabel="Đang thêm…"
          disabled={disabled || unavailable}
          onClick={() => onAdd(item)}
        >
          Thêm món
        </Button>
      ) : null}
    </article>
  );
}
