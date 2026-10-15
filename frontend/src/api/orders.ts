import { apiRequest } from "./client";
import type { components, paths } from "./schema";

export type CreateOrderRequest = components["schemas"]["CreateOrderRequest"];
export type AddItemsRequest = components["schemas"]["AddItemsRequest"];
export type UpdateOrderItemRequest = components["schemas"]["UpdateOrderItemRequest"];
export type OrderDetail = components["schemas"]["OrderDetailOut"];
export type OrderItemDetail = components["schemas"]["OrderItemDetailOut"];

export type CreateOrderResponse = paths["/api/v1/orders"]["post"]["responses"][201]["content"]["application/json"];
export type AddItemsResponse = paths["/api/v1/orders/{order_id}/items"]["post"]["responses"][201]["content"]["application/json"];
export type UpdateItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}"]["patch"]["responses"][200]["content"]["application/json"];
export type RemoveItemResponse = paths["/api/v1/orders/{order_id}/items/{item_id}"]["delete"]["responses"][200]["content"]["application/json"];
export type SendToKitchenResponse = paths["/api/v1/orders/{order_id}/send-to-kitchen"]["post"]["responses"][200]["content"]["application/json"];
export type GetOrderResponse = paths["/api/v1/orders/{order_id}"]["get"]["responses"][200]["content"]["application/json"];

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
