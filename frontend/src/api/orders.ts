import { apiRequest } from "./client";
import type { components, paths } from "./schema";

export type CreateOrderRequest = components["schemas"]["CreateOrderRequest"];
export type AddItemsRequest = components["schemas"]["AddItemsRequest"];
export type UpdateOrderItemRequest = components["schemas"]["UpdateOrderItemRequest"];
export type OrderDetail = components["schemas"]["OrderDetailOut"];
export type OrderItemDetail = components["schemas"]["OrderItemDetailOut"];
export type OrderSummaryRow = components["schemas"]["OrderSummaryOut"];
export type VoidItemRequest = components["schemas"]["VoidItemRequest"];

export type CreateOrderResponse = paths["/api/v1/orders"]["post"]["responses"][201]["content"]["application/json"];
export type AddItemsResponse = paths["/api/v1/orders/{order_id}/items"]["post"]["responses"][201]["content"]["application/json"];
export type UpdateItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}"]["patch"]["responses"][200]["content"]["application/json"];
export type RemoveItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}"]["delete"]["responses"][200]["content"]["application/json"];
export type SendToKitchenResponse = paths["/api/v1/orders/{order_id}/send-to-kitchen"]["post"]["responses"][200]["content"]["application/json"];
export type GetOrderResponse = paths["/api/v1/orders/{order_id}"]["get"]["responses"][200]["content"]["application/json"];
export type PickupItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}/pickup"]["post"]["responses"][200]["content"]["application/json"];
export type ServeItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}/served"]["post"]["responses"][200]["content"]["application/json"];
export type RequestBillingResponse = paths["/api/v1/orders/{order_id}/request-billing"]["post"]["responses"][200]["content"]["application/json"];
export type PayOrderResponse = paths["/api/v1/orders/{order_id}/pay"]["post"]["responses"][200]["content"]["application/json"];
export type CloseOrderResponse = paths["/api/v1/orders/{order_id}/close"]["post"]["responses"][200]["content"]["application/json"];
export type VoidItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}/void"]["post"]["responses"][200]["content"]["application/json"];
export type RefireItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}/refire"]["post"]["responses"][200]["content"]["application/json"];

export interface ListOrdersParams {
  status?: readonly string[] | undefined;
  tableId?: string | undefined;
  /** ISO 8601, created_at >= */
  createdFrom?: string | undefined;
  /** ISO 8601, created_at < */
  createdTo?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** GET /orders: mới nhất trước, tối đa 200 dòng mỗi lần gọi. */
export function listOrders(params: ListOrdersParams = {}): Promise<OrderSummaryRow[]> {
  const query = new URLSearchParams();
  for (const status of params.status ?? []) query.append("status", status);
  if (params.tableId) query.set("table_id", params.tableId);
  if (params.createdFrom) query.set("created_from", params.createdFrom);
  if (params.createdTo) query.set("created_to", params.createdTo);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  const suffix = query.toString();
  return apiRequest<OrderSummaryRow[]>(suffix ? `/orders?${suffix}` : "/orders");
}

export function createOrder(body: CreateOrderRequest, idempotencyKey: string): Promise<CreateOrderResponse> {
  return apiRequest<CreateOrderResponse, CreateOrderRequest>("/orders", {
    method: "POST",
    body,
    idempotencyKey,
  });
}

export function addItems(orderId: string, body: AddItemsRequest, idempotencyKey: string): Promise<AddItemsResponse> {
  return apiRequest<AddItemsResponse, AddItemsRequest>(`/orders/${encodeURIComponent(orderId)}/items`, {
    method: "POST",
    body,
    idempotencyKey,
  });
}

export function updateItem(
  orderId: string,
  itemId: string,
  body: UpdateOrderItemRequest,
  idempotencyKey: string,
): Promise<UpdateItemResponse> {
  return apiRequest<UpdateItemResponse, UpdateOrderItemRequest>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body, idempotencyKey },
  );
}

export function removeItem(orderId: string, itemId: string, idempotencyKey: string): Promise<RemoveItemResponse> {
  return apiRequest<RemoveItemResponse>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE", idempotencyKey },
  );
}

export function sendToKitchen(orderId: string, idempotencyKey: string): Promise<SendToKitchenResponse> {
  return apiRequest<SendToKitchenResponse>(`/orders/${encodeURIComponent(orderId)}/send-to-kitchen`, {
    method: "POST",
    idempotencyKey,
  });
}

export function getOrder(orderId: string): Promise<GetOrderResponse> {
  return apiRequest<GetOrderResponse>(`/orders/${encodeURIComponent(orderId)}`);
}

export function pickupItem(orderId: string, itemId: string, idempotencyKey: string): Promise<PickupItemResponse> {
  return apiRequest<PickupItemResponse>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/pickup`,
    { method: "POST", idempotencyKey },
  );
}

export function serveItem(orderId: string, itemId: string, idempotencyKey: string): Promise<ServeItemResponse> {
  return apiRequest<ServeItemResponse>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/served`,
    { method: "POST", idempotencyKey },
  );
}

export function requestBilling(orderId: string, idempotencyKey: string): Promise<RequestBillingResponse> {
  return apiRequest<RequestBillingResponse>(`/orders/${encodeURIComponent(orderId)}/request-billing`, {
    method: "POST",
    idempotencyKey,
  });
}

export function payOrder(orderId: string, idempotencyKey: string): Promise<PayOrderResponse> {
  return apiRequest<PayOrderResponse>(`/orders/${encodeURIComponent(orderId)}/pay`, {
    method: "POST",
    idempotencyKey,
  });
}

/** PAID -> CLOSED (chốt sổ). Chỉ CASHIER và SUPERVISOR. */
export function closeOrder(orderId: string, idempotencyKey: string): Promise<CloseOrderResponse> {
  return apiRequest<CloseOrderResponse>(`/orders/${encodeURIComponent(orderId)}/close`, {
    method: "POST",
    idempotencyKey,
  });
}

/** Hủy món chưa phục vụ (CREATED/SENT/ACCEPTED/PREPARING). Chỉ SUPERVISOR. */
export function voidItem(
  orderId: string,
  itemId: string,
  body: VoidItemRequest,
  idempotencyKey: string,
): Promise<VoidItemResponse> {
  return apiRequest<VoidItemResponse, VoidItemRequest>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/void`,
    { method: "POST", body, idempotencyKey },
  );
}

/** Làm lại món đã SERVED/PICKED_UP: món quay lại hàng chờ bếp. Chỉ SUPERVISOR. */
export function refireItem(orderId: string, itemId: string, idempotencyKey: string): Promise<RefireItemResponse> {
  return apiRequest<RefireItemResponse>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/refire`,
    { method: "POST", idempotencyKey },
  );
}

export type SplitOrderResponse = paths["/api/v1/orders/{order_id}/split"]["post"]["responses"][201]["content"]["application/json"];

export function splitOrder(
  orderId: string,
  items: { order_item_id: string; quantity: number }[],
  idempotencyKey: string,
): Promise<SplitOrderResponse> {
  return apiRequest<SplitOrderResponse, { items: { order_item_id: string; quantity: number }[] }>(`/orders/${encodeURIComponent(orderId)}/split`, {
    method: "POST",
    body: { items },
    idempotencyKey,
  });
}
