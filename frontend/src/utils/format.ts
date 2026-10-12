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
