import { useRef, useState } from "react";
import type { OrderDetail } from "../api/orders";
import { FormDialog } from "./FormDialog";
import { formatVnd } from "../utils/format";

interface SplitBillDialogProps {
  order: OrderDetail;
  onSubmit: (items: { order_item_id: string; quantity: number }[]) => Promise<string | null>;
  onCancel: () => void;
}

/** Món đã vào bếp chỉ tách được nguyên dòng; món mới/đã phục vụ tách được theo số lượng. */
function canSplitByQuantity(status: string): boolean {
  return status === "CREATED" || status === "SERVED";
}

export function SplitBillDialog({ order, onSubmit, onCancel }: SplitBillDialogProps) {
  const lines = order.items.filter((item) => item.status !== "VOIDED");
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  const totalQty = lines.reduce((sum, item) => sum + item.quantity, 0);
  const pickedQty = Object.values(picked).reduce((sum, value) => sum + value, 0);
  const valid = pickedQty > 0 && pickedQty < totalQty;

  function setQty(id: string, quantity: number, max: number) {
    setError("");
    setPicked((current) => ({ ...current, [id]: Math.max(0, Math.min(max, quantity)) }));
  }

  async function submit() {
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const items = Object.entries(picked)
        .filter(([, quantity]) => quantity > 0)
        .map(([order_item_id, quantity]) => ({ order_item_id, quantity }));
      const message = await onSubmit(items);
      if (message) setError(message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title="Tách bill"
      titleId="nova-split-title"
      busy={busy}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      submitLabel="Tách bill"
      submitDisabled={!valid}
      error={error}
      wide
    >
      <p>Chọn món chuyển sang hóa đơn mới của cùng bàn. Phải để lại ít nhất 1 món ở hóa đơn cũ.</p>
      <ul className="nova-split-list" aria-label="Món có thể tách">
        {lines.map((item) => {
          const byQty = canSplitByQuantity(item.status);
          const value = picked[item.id] ?? 0;
          return (
            <li key={item.id} className="nova-split-row" data-testid="split-row">
              <div>
                <strong>{item.menu_item_name}</strong>
                <small>{item.quantity} × {formatVnd(item.unit_price)}{byQty ? "" : " · Đã vào bếp, chỉ tách cả dòng"}</small>
              </div>
              {byQty ? (
                <div className="nova-split-stepper">
                  <button type="button" aria-label={`Giảm số lượng tách ${item.menu_item_name}`} disabled={busy || value <= 0} onClick={() => setQty(item.id, value - 1, item.quantity)}>−</button>
                  <output aria-label={`Số lượng tách ${item.menu_item_name}`}>{value}</output>
                  <button type="button" aria-label={`Tăng số lượng tách ${item.menu_item_name}`} disabled={busy || value >= item.quantity} onClick={() => setQty(item.id, value + 1, item.quantity)}>+</button>
                </div>
              ) : (
                <label className="nova-split-whole">
                  <input type="checkbox" checked={value > 0} disabled={busy} onChange={(event) => setQty(item.id, event.target.checked ? item.quantity : 0, item.quantity)} />
                  Tách cả dòng
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </FormDialog>
  );
}
