const STATUS_META: Record<string, { label: string; className: string }> = {
  AVAILABLE: { label: "Trống", className: "available" },
  OCCUPIED: { label: "Đang phục vụ", className: "occupied" },
  BILLING: { label: "Chờ thanh toán", className: "billing" },
  PAID: { label: "Đã thanh toán", className: "paid" },
  CLEANING: { label: "Đang dọn", className: "cleaning" },
  RESERVED: { label: "Đã đặt", className: "reserved" },
  DELAYED: { label: "Chậm phục vụ", className: "delayed" },
  MERGED: { label: "Đã gộp", className: "merged" },
  NEW: { label: "Đơn mới", className: "new" },
  CREATED: { label: "Chưa gửi bếp", className: "new" },
  SENT: { label: "Đã gửi bếp", className: "sent" },
  ACCEPTED: { label: "Bếp đã nhận", className: "sent" },
  PREPARING: { label: "Đang chế biến", className: "preparing" },
  READY: { label: "Sẵn sàng", className: "ready" },
  PICKED_UP: { label: "Đã lấy món", className: "ready" },
  SERVED: { label: "Đã phục vụ", className: "served" },
  VOIDED: { label: "Đã hủy", className: "voided" },
  UNAVAILABLE: { label: "Hết món", className: "unavailable" },
  NORMAL: { label: "Đúng tiến độ", className: "normal" },
  CRITICAL: { label: "Rất trễ", className: "critical" },
};

export function getStatusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, className: "merged" };
}
