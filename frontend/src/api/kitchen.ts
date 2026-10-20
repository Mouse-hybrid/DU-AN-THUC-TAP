import { apiRequest } from "./client";
import type { paths } from "./schema";

export type KitchenQueueResponse = paths["/api/v1/kitchen/queue"]["get"]["responses"][200]["content"]["application/json"];
export type KitchenStationResponse = paths["/api/v1/kitchen/stations"]["get"]["responses"][200]["content"]["application/json"];
export type StartCookingResponse = paths["/api/v1/orders/{order_id}/items/{item_id}/start-cooking"]["post"]["responses"][200]["content"]["application/json"];
export type MarkReadyResponse = paths["/api/v1/orders/{order_id}/items/{item_id}/mark-ready"]["post"]["responses"][200]["content"]["application/json"];

type QueueQuery = NonNullable<paths["/api/v1/kitchen/queue"]["get"]["parameters"]["query"]>;

export function listQueue(
  status: QueueQuery["status"],
  stationId?: QueueQuery["station_id"],
  itemStatuses?: QueueQuery["item_status"],
): Promise<KitchenQueueResponse> {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (stationId) query.set("station_id", stationId);
  itemStatuses?.forEach((itemStatus) => query.append("item_status", itemStatus));
  return apiRequest<KitchenQueueResponse>(`/kitchen/queue?${query.toString()}`);
}

export function listStations(): Promise<KitchenStationResponse> {
  return apiRequest<KitchenStationResponse>("/kitchen/stations");
}

export function startCooking(orderId: string, itemId: string, idempotencyKey: string): Promise<StartCookingResponse> {
  return apiRequest<StartCookingResponse>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/start-cooking`,
    { method: "POST", idempotencyKey },
  );
}

export function markReady(orderId: string, itemId: string, idempotencyKey: string): Promise<MarkReadyResponse> {
  return apiRequest<MarkReadyResponse>(
    `/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/mark-ready`,
    { method: "POST", idempotencyKey },
  );
}
