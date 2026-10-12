import type { paths } from "./schema";
import { apiRequest } from "./client";

export type TableListResponse = paths["/api/v1/tables"]["get"]["responses"][200]["content"]["application/json"];
export type TableDetailResponse = paths["/api/v1/tables/{table_id}"]["get"]["responses"][200]["content"]["application/json"];
export type MarkCleanResponse = paths["/api/v1/tables/{table_id}/mark-clean"]["post"]["responses"][200]["content"]["application/json"];

export function listTables(): Promise<TableListResponse> {
  return apiRequest<TableListResponse>("/tables");
}

export function getTable(tableId: string): Promise<TableDetailResponse> {
  return apiRequest<TableDetailResponse>(`/tables/${encodeURIComponent(tableId)}`);
}

export function markClean(tableId: string, idempotencyKey: string): Promise<MarkCleanResponse> {
  return apiRequest<MarkCleanResponse>(`/tables/${encodeURIComponent(tableId)}/mark-clean`, {
    method: "POST",
    idempotencyKey,
  });
}
