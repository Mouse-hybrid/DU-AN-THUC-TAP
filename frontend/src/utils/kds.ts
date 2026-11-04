import { orderShortCode } from "./format";

export const SLA_LABELS: Record<string, string> = {
  NORMAL: "Đúng tiến độ",
  WARNING: "Sắp trễ",
  DELAYED: "Trễ",
  CRITICAL: "Rất trễ",
};

/** Mã phiếu tạm hiển thị trên phiếu bếp: "B4-1A2B" (backend chưa có mã phiếu riêng). */
export function ticketCode(tableCode: string, orderId: string): string {
  return `${tableCode}-${orderShortCode(orderId)}`;
}
