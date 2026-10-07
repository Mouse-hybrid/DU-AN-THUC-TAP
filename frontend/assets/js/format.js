const vndFormatter = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export const TABLE_STATUS_LABELS = Object.freeze({
  AVAILABLE: "Trống",
  OCCUPIED: "Đang phục vụ",
  BILLING: "Chờ thanh toán",
  PAID: "Đã thanh toán",
  CLEANING: "Đang dọn",
  RESERVED: "Đã đặt",
  DELAYED: "Chậm phục vụ",
  MERGED: "Đã gộp",
});

export function formatVnd(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return "—";
  return vndFormatter.format(numericValue).replace(/\u00a0/g, " ");
}

export function formatOpenDuration(openedAt) {
  if (!openedAt) return "Chưa mở phiên";
  const openedTime = new Date(openedAt).getTime();
  if (!Number.isFinite(openedTime)) return "Không rõ thời gian";

  const minutes = Math.max(0, Math.floor((Date.now() - openedTime) / 60_000));
  if (minutes < 60) return `${minutes}p`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}g ${remainingMinutes}p` : `${hours}g`;
}

export function tableStatusLabel(status) {
  return TABLE_STATUS_LABELS[status] || status || "Không rõ";
}
