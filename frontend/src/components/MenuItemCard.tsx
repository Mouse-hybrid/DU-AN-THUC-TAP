import type { components } from "../api/schema";
import { formatVnd } from "../utils/format";
import { Button } from "./Button";
import { MenuThumb } from "./MenuThumb";
import { StatusBadge } from "./StatusBadge";

type MenuItem = components["schemas"]["MenuItemOut"];

interface MenuItemCardProps {
  item: MenuItem;
  busy?: boolean;
  disabled?: boolean;
  showAddAction?: boolean;
  addLabel?: string;
  layout?: "card" | "row";
  categoryName?: string | undefined;
  onAdd: (item: MenuItem) => void;
}

export function MenuItemCard({ item, busy = false, disabled = false, showAddAction = true, addLabel = "Thêm món", layout = "card", categoryName, onAdd }: MenuItemCardProps) {
  const unavailable = !item.is_available;
  if (layout === "row") {
    return (
      <article className={`nova-menu-row${unavailable ? " nova-menu-row--unavailable" : ""}`}>
        <MenuThumb name={item.name} className="nova-menu-row-thumb" />
        <div className="nova-menu-row-copy">
          <h3>{item.name}</h3>
          {categoryName ? <p>{categoryName}</p> : null}
        </div>
        {unavailable ? <StatusBadge status="UNAVAILABLE" label="Hết món" /> : null}
        <strong className="nova-menu-row-price">{formatVnd(item.price)}</strong>
        {showAddAction ? (
          <Button
            variant="primary"
            type="button"
            className="nova-menu-row-action"
            accessibleLabel={`Thêm ${item.name} vào đơn`}
            busy={busy}
            busyLabel="Đang thêm…"
            disabled={disabled || unavailable}
            onClick={() => onAdd(item)}
          >
            {addLabel}
          </Button>
        ) : null}
      </article>
    );
  }
  return (
    <article className={`nova-menu-card${unavailable ? " nova-menu-card--unavailable" : ""}`}>
      <MenuThumb name={item.name} className="nova-menu-card-photo" />
      <div className="nova-menu-card-copy">
        <h3>{item.name}</h3>
        <strong>{formatVnd(item.price)}</strong>
      </div>
      {unavailable ? <StatusBadge status="UNAVAILABLE" label="Hết món" /> : null}
      {showAddAction ? (
        <Button
          variant="primary"
          type="button"
          accessibleLabel={`Thêm ${item.name} vào đơn`}
          busy={busy}
          busyLabel="Đang thêm…"
          disabled={disabled || unavailable}
          onClick={() => onAdd(item)}
        >
          {addLabel}
        </Button>
      ) : null}
    </article>
  );
}
