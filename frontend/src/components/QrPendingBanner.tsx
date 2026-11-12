import type { OrderDetail } from "../api/orders";

interface QrPendingBannerProps {
  orders: OrderDetail[];
  children?: React.ReactNode;
}

/** Món khách tự gọi qua QR đang chờ phục vụ xác nhận (CREATED, source QR). */
export function QrPendingBanner({ orders, children }: QrPendingBannerProps) {
  const pending = orders.reduce(
    (sum, order) => sum + order.items.filter((item) => item.source === "QR" && item.status === "CREATED").length,
    0,
  );
  if (pending === 0) return null;
  return (
    <section className="nova-qr-pending" role="status" data-testid="qr-pending">
      <strong>Khách gọi {pending} món qua QR, đang chờ xác nhận</strong>
      <p>Bấm “Gửi bếp” để xác nhận, hoặc “Xóa” món để từ chối.</p>
      {children}
    </section>
  );
}
