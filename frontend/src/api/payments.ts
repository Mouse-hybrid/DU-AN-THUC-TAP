import { apiRequest } from "./client";
import type { components } from "./schema";

export type CreatePaymentBody = components["schemas"]["CreatePaymentRequest"];
export type PaymentRecord = components["schemas"]["PaymentOut"];
export type PaymentSummary = components["schemas"]["PaymentSummaryOut"];
export type OrderPayments = components["schemas"]["OrderPaymentsOut"];
export type PaymentRecorded = components["schemas"]["PaymentRecordedOut"];

/** GET /orders/{id}/payments: các lần thu tiền của đơn kèm tổng kết (total, paid, refunded, remaining). */
export function listPayments(orderId: string): Promise<OrderPayments> {
  return apiRequest<OrderPayments>(`/orders/${encodeURIComponent(orderId)}/payments`);
}

/** POST /orders/{id}/payments: một lần thu (tiền mặt hoặc thẻ). Đơn phải ở BILLING; trả đủ thì đơn chuyển PAID. */
export function recordPayment(orderId: string, body: CreatePaymentBody, idempotencyKey: string): Promise<PaymentRecorded> {
  return apiRequest<PaymentRecorded, CreatePaymentBody>(`/orders/${encodeURIComponent(orderId)}/payments`, {
    method: "POST",
    body,
    idempotencyKey,
  });
}

/** POST /payments/{id}/cancel: hủy lần ghi nhầm khi đơn còn BILLING (quyền PAYMENT_REFUND), trả lại danh sách thanh toán mới. */
export function cancelPayment(paymentId: string, reason: string, idempotencyKey: string): Promise<OrderPayments> {
  return apiRequest<OrderPayments, { reason: string }>(`/payments/${encodeURIComponent(paymentId)}/cancel`, {
    method: "POST",
    body: { reason },
    idempotencyKey,
  });
}

/** POST /payments/{id}/refunds: hoàn tiền sau khi đơn đã PAID/CLOSED. Bỏ `amount` = hoàn hết phần chưa hoàn. */
export function refundPayment(
  paymentId: string,
  body: { amount?: string; reason: string },
  idempotencyKey: string,
): Promise<OrderPayments> {
  return apiRequest<OrderPayments, { amount?: string; reason: string }>(`/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: "POST",
    body,
    idempotencyKey,
  });
}
