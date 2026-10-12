const STATUS_META: Record<string, { label: string; className: string }> = {
  AVAILABLE: { label: "Trống", className: "available" },
  OCCUPIED: { label: "Đang phục vụ", className: "occupied" },
  BILLING: { label: "Chờ thanh toán", className: "billing" },
  PAID: { label: "Đã thanh toán", className: "paid" },
  CLEANING: { label: "Đang dọn", className: "cleaning" },
  RESERVED: { label: "Đã đặt", className: "reserved" },
  DELAYED: { label: "Chậm phục vụ", className: "delayed" },
  MERGED: { label: "Đã gộp", className: "merged" },
};

export function getStatusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, className: "merged" };
}
