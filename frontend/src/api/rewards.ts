import type { components } from "./schema";
import { apiRequest } from "./client";

export type Customer = components["schemas"]["CustomerOut"];
export type EligibleReward = components["schemas"]["EligibleRewardOut"];
export type AppliedReward = components["schemas"]["AppliedRewardOut"];
type OrderDetail = components["schemas"]["OrderDetailOut"];
type CustomerCreate = components["schemas"]["CustomerCreate"];

export function findCustomersByPhone(phone: string): Promise<Customer[]> {
  return apiRequest<Customer[]>(`/customers?phone=${encodeURIComponent(phone)}&limit=1`);
}

export function getCustomer(customerId: string): Promise<Customer> {
  return apiRequest<Customer>(`/customers/${encodeURIComponent(customerId)}`);
}

export function createCustomer(body: CustomerCreate, idempotencyKey: string): Promise<Customer> {
  return apiRequest<Customer, CustomerCreate>("/customers", { method: "POST", body, idempotencyKey });
}

export function attachCustomer(orderId: string, customerId: string | null, idempotencyKey: string): Promise<unknown> {
  return apiRequest<unknown, { customer_id: string | null }>(`/orders/${encodeURIComponent(orderId)}/customer`, {
    method: "POST",
    body: { customer_id: customerId },
    idempotencyKey,
  });
}

export function listEligibleRewards(orderId: string): Promise<EligibleReward[]> {
  return apiRequest<EligibleReward[]>(`/orders/${encodeURIComponent(orderId)}/eligible-rewards`);
}

export interface ApplyRewardBody {
  reward_id: string;
  points?: number;
  override_reason?: string;
}

export function applyReward(orderId: string, body: ApplyRewardBody, idempotencyKey: string): Promise<OrderDetail> {
  return apiRequest<OrderDetail, ApplyRewardBody>(`/orders/${encodeURIComponent(orderId)}/rewards`, {
    method: "POST",
    body,
    idempotencyKey,
  });
}

export function removeReward(orderId: string, orderRewardId: string, idempotencyKey: string): Promise<OrderDetail> {
  return apiRequest<OrderDetail>(
    `/orders/${encodeURIComponent(orderId)}/rewards/${encodeURIComponent(orderRewardId)}`,
    { method: "DELETE", idempotencyKey },
  );
}

export type PendingMember = components["schemas"]["PendingMemberOut"];

/** Số điện thoại khách nhập trên trang QR cho bàn của đơn này (chờ thu ngân đăng ký hoặc gắn). */
export function getPendingMember(orderId: string): Promise<PendingMember> {
  return apiRequest<PendingMember>(`/orders/${encodeURIComponent(orderId)}/pending-member`);
}

export type PointsEntry = components["schemas"]["PointsEntryOut"];

/** GET /customers: cả danh sách hội viên (quyền LOYALTY_MANAGE, mặc định quản lý). */
export function listCustomers(limit = 200, offset = 0): Promise<Customer[]> {
  return apiRequest<Customer[]>(`/customers?limit=${limit}&offset=${offset}`);
}

/** GET /customers/{id}/points: sổ điểm của một hội viên, mới nhất trước. */
export function listPoints(customerId: string, limit = 200): Promise<PointsEntry[]> {
  return apiRequest<PointsEntry[]>(`/customers/${encodeURIComponent(customerId)}/points?limit=${limit}`);
}

/** POST /customers/{id}/points/adjust: cộng (số dương) hoặc trừ (số âm) điểm, bắt buộc lý do. */
export function adjustPoints(customerId: string, body: { points: number; reason: string }, idempotencyKey: string): Promise<PointsEntry> {
  return apiRequest<PointsEntry, { points: number; reason: string }>(`/customers/${encodeURIComponent(customerId)}/points/adjust`, {
    method: "POST",
    body,
    idempotencyKey,
  });
}

/** PATCH /customers/{id}: sửa tên hoặc khóa/mở khóa hội viên. */
export function updateCustomer(customerId: string, body: { full_name?: string | null; is_active?: boolean }, idempotencyKey: string): Promise<Customer> {
  return apiRequest<Customer, { full_name?: string | null; is_active?: boolean }>(`/customers/${encodeURIComponent(customerId)}`, {
    method: "PATCH",
    body,
    idempotencyKey,
  });
}
