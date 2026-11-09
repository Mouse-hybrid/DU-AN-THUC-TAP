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
