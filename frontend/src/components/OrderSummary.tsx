import type { components } from "../api/schema";
import { formatVnd } from "../utils/format";

type OrderDetail = components["schemas"]["OrderDetailOut"];

interface OrderSummaryProps {
  order: OrderDetail | null;
}

function clientSubtotal(order: OrderDetail): number | null {
  let subtotal = 0;
  for (const item of order.items) {
    if (item.status === "VOIDED") continue;
    const lineTotal = Number(item.line_total);
    if (!Number.isFinite(lineTotal)) return null;
    subtotal += lineTotal;
  }
  return subtotal;
}

export function OrderSummary({ order }: OrderSummaryProps) {
  if (!order) {
    return (
      <section className="nova-order-summary" aria-label="Tóm tắt đơn">
        <h2>Đơn hiện tại</h2>
        <p>Chưa có món. Đơn sẽ được tạo khi thêm món đầu tiên.</p>
        <div className="nova-order-total"><span>Tạm tính</span><strong>{formatVnd("0")}</strong></div>
      </section>
    );
  }

  const calculated = clientSubtotal(order);
  const apiSubtotal = Number(order.subtotal);
  const mismatch = calculated !== null && Number.isFinite(apiSubtotal) && Math.abs(calculated - apiSubtotal) >= 0.5;

  return (
    <section className="nova-order-summary" aria-label="Tóm tắt đơn">
      <div className="nova-order-summary-heading">
        <h2>Đơn hiện tại</h2>
        <span>{order.items.filter((item) => item.status !== "VOIDED").length} dòng món</span>
      </div>
      <div className="nova-order-total">
        <span>Tạm tính</span>
        <strong>{calculated === null ? "—" : formatVnd(String(calculated))}</strong>
      </div>
      {mismatch ? (
        <p className="nova-order-mismatch" role="alert">
          Tổng trên thiết bị chưa khớp dữ liệu máy chủ ({formatVnd(order.subtotal)}). Hãy tải lại đơn.
        </p>
      ) : null}
    </section>
  );
}
