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

export type TableTransferResponse = paths["/api/v1/tables/{table_id}/transfer"]["post"]["responses"][200]["content"]["application/json"];
export type TableMergeResponse = paths["/api/v1/tables/{table_id}/merge"]["post"]["responses"][200]["content"]["application/json"];

export function transferTable(tableId: string, targetTableId: string, idempotencyKey: string): Promise<TableTransferResponse> {
  return apiRequest<TableTransferResponse, { target_table_id: string }>(`/tables/${encodeURIComponent(tableId)}/transfer`, {
    method: "POST",
    body: { target_table_id: targetTableId },
    idempotencyKey,
  });
}

export function mergeTables(tableId: string, tableIds: string[], idempotencyKey: string): Promise<TableMergeResponse> {
  return apiRequest<TableMergeResponse, { table_ids: string[] }>(`/tables/${encodeURIComponent(tableId)}/merge`, {
    method: "POST",
    body: { table_ids: tableIds },
    idempotencyKey,
  });
}
