const vndFormatter = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export function formatVnd(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? vndFormatter.format(amount) : "—";
}

const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseApiTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(TIMEZONE_SUFFIX.test(value) ? value : `${value}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatOpenDuration(openedAt: string | null | undefined): string {
  const openedTime = parseApiTimestamp(openedAt);
  if (openedTime === null) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - openedTime) / 60_000));
  if (minutes < 60) return `${minutes}p`;
  return `${Math.floor(minutes / 60)}g ${minutes % 60}p`;
}

/** Mã đơn ngắn hiển thị cho nhân viên (4 ký tự cuối của id), thống nhất với màn chi tiết bàn và bếp. */
export function orderShortCode(id: string): string {
  return id.replaceAll("-", "").slice(-4).toUpperCase();
}

const timeFormatter = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateFormatter = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "19:42" nếu là hôm nay, ngược lại "26/10 19:42". */
export function formatShortDateTime(value: string | null | undefined): string {
  const timestamp = parseApiTimestamp(value);
  if (timestamp === null) return "—";
  const date = new Date(timestamp);
  const time = timeFormatter.format(date);
  if (isSameLocalDay(date, new Date())) return time;
  return `${dateFormatter.format(date).slice(0, 5)} ${time}`;
}

/** "26/10/2026 19:42:07" cho nhật ký hệ thống. */
export function formatFullDateTime(value: string | null | undefined): string {
  const timestamp = parseApiTimestamp(value);
  if (timestamp === null) return "—";
  const date = new Date(timestamp);
  return `${dateFormatter.format(date)} ${timeFormatter.format(date)}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function formatDateOnly(date: Date): string {
  return dateFormatter.format(date);
}

/** Đầu ngày (giờ máy) lùi `daysBack` ngày, dạng ISO để gửi lên API. */
export function startOfDayIso(daysBack: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.toISOString();
}
