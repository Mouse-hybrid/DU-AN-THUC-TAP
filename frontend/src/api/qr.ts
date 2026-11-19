import type { components } from "./schema";
import { apiRequest } from "./client";

export type QrSession = components["schemas"]["QrSessionOut"];
export type QrMenu = components["schemas"]["QrMenuOut"];
export type QrMenuItem = components["schemas"]["QrMenuItemOut"];
export type QrOrder = components["schemas"]["QrOrderOut"];
export type QrOrderLine = components["schemas"]["QrOrderLine"];
export type QrTableInfo = components["schemas"]["QrInfoOut"];

const base = (tableId: string) => `/tables/${encodeURIComponent(tableId)}/qr-session`;
const pub = (token: string) => `/public/qr/${encodeURIComponent(token)}`;

// --- Nhân viên (cần đăng nhập, quyền QR_SESSION_MANAGE) ---
export function getQrSession(tableId: string): Promise<QrSession> {
  return apiRequest<QrSession>(base(tableId));
}

export function issueQrSession(tableId: string, idempotencyKey: string): Promise<QrSession> {
  return apiRequest<QrSession>(base(tableId), { method: "POST", idempotencyKey });
}

export function revokeQrSession(tableId: string, idempotencyKey: string): Promise<void> {
  return apiRequest<void>(base(tableId), { method: "DELETE", idempotencyKey });
}

// --- Khách quét mã (không đăng nhập, token trong URL) ---
export function getQrTable(token: string): Promise<QrTableInfo> {
  return apiRequest<QrTableInfo>(pub(token), { auth: false });
}

export function getQrMenu(token: string): Promise<QrMenu> {
  return apiRequest<QrMenu>(`${pub(token)}/menu`, { auth: false });
}

export function getQrOrder(token: string): Promise<QrOrder> {
  return apiRequest<QrOrder>(`${pub(token)}/order`, { auth: false });
}

export function submitQrOrder(token: string, items: QrOrderLine[], idempotencyKey: string): Promise<unknown> {
  return apiRequest<unknown, { items: QrOrderLine[] }>(`${pub(token)}/orders`, {
    method: "POST",
    body: { items },
    idempotencyKey,
    auth: false,
  });
}

/** Khách bấm "Yêu cầu thanh toán": các món đã gửi bếp chuyển sang chờ thanh toán, khóa gọi thêm. */
export function requestQrBill(token: string, idempotencyKey: string): Promise<QrOrder> {
  return apiRequest<QrOrder>(`${pub(token)}/request-bill`, { method: "POST", idempotencyKey, auth: false });
}

export type QrMemberResult = components["schemas"]["QrMemberOut"];

/** Khách nhập số điện thoại để tích điểm (chỉ tích, không đổi điểm trên QR). Luôn trả số đã che. */
export function submitQrMember(token: string, phone: string, idempotencyKey: string): Promise<QrMemberResult> {
  return apiRequest<QrMemberResult, { phone: string }>(`${pub(token)}/member`, {
    method: "POST",
    body: { phone },
    idempotencyKey,
    auth: false,
  });
}
