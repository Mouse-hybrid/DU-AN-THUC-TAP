import { useEffect, useState } from "react";
import type { components } from "../api/schema";
import { formatVnd } from "../utils/format";
import { Button } from "./Button";
import { QuantityStepper } from "./QuantityStepper";
import { StatusBadge } from "./StatusBadge";

type OrderItem = components["schemas"]["OrderItemDetailOut"];

interface OrderLineItemProps {
  item: OrderItem;
  editable: boolean;
  updating?: boolean;
  removing?: boolean;
  onUpdate: (item: OrderItem, quantity: number, note: string | null) => void;
  onRemove: (item: OrderItem) => void;
}

export function OrderLineItem({ item, editable, updating = false, removing = false, onUpdate, onRemove }: OrderLineItemProps) {
  const [quantity, setQuantity] = useState(item.quantity);
  const [note, setNote] = useState(item.note ?? "");

  useEffect(() => {
    setQuantity(item.quantity);
    setNote(item.note ?? "");
  }, [item.id, item.note, item.quantity]);

  const changed = quantity !== item.quantity || note.trim() !== (item.note ?? "");

  return (
    <article className={`nova-order-line${item.status === "VOIDED" ? " nova-order-line--voided" : ""}`}>
      <div className="nova-order-line-heading">
        <div>
          <h3>{item.menu_item_name}</h3>
          <p>{formatVnd(item.unit_price)} / món</p>
        </div>
        <StatusBadge status={item.status} />
      </div>
      {editable ? (
        <>
          <QuantityStepper
            value={quantity}
            min={1}
            label={`số lượng ${item.menu_item_name}`}
            disabled={updating || removing}
            onChange={setQuantity}
          />
          <label className="nova-order-note">
            <span>Ghi chú</span>
            <input
              value={note}
              maxLength={500}
              disabled={updating || removing}
              placeholder="Ví dụ: ít cay"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="nova-order-line-actions">
            <Button
              variant="secondary"
              type="button"
              accessibleLabel={`Cập nhật ${item.menu_item_name}`}
              busy={updating}
              disabled={!changed || removing}
              onClick={() => onUpdate(item, quantity, note.trim() || null)}
            >
              Cập nhật
            </Button>
            <Button
              variant="danger"
              type="button"
              accessibleLabel={`Xóa ${item.menu_item_name} khỏi đơn`}
              busy={removing}
              disabled={updating}
              onClick={() => onRemove(item)}
            >
              Xóa
            </Button>
          </div>
        </>
      ) : (
        <div className="nova-order-line-readonly">
          <span>Số lượng: <strong>{item.quantity}</strong></span>
          {item.note ? <span>Ghi chú: {item.note}</span> : null}
        </div>
      )}
      <strong className="nova-order-line-total">{formatVnd(item.line_total)}</strong>
    </article>
  );
}
