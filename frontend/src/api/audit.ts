import { apiDownload, apiRequest, type DownloadResult } from "./client";
import type { components } from "./schema";

export type AuditSummary = components["schemas"]["AuditSummaryOut"];
export type AuditLog = components["schemas"]["AuditLogOut"];

export interface ListAuditLogsParams {
  orderId?: string | undefined;
  entityType?: string | undefined;
  actions?: readonly string[] | undefined;
  staffId?: string | undefined;
  /** ISO 8601, created_at >= */
  createdFrom?: string | undefined;
  /** ISO 8601, created_at < */
  createdTo?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function filterQuery(params: ListAuditLogsParams): string {
  const query = new URLSearchParams();
  if (params.orderId) query.set("order_id", params.orderId);
  if (params.entityType) query.set("entity_type", params.entityType);
  for (const action of params.actions ?? []) query.append("action", action);
  if (params.staffId) query.set("staff_id", params.staffId);
  if (params.createdFrom) query.set("created_from", params.createdFrom);
  if (params.createdTo) query.set("created_to", params.createdTo);
  return query.toString();
}

/** GET /audit-logs/summary (SUPERVISOR): báo cáo tổng hợp, tối đa 93 ngày. */
export function getAuditSummary(params: ListAuditLogsParams = {}): Promise<AuditSummary> {
  const suffix = filterQuery(params);
  return apiRequest<AuditSummary>(suffix ? `/audit-logs/summary?${suffix}` : "/audit-logs/summary");
}

/** GET /audit-logs/export (SUPERVISOR): CSV UTF-8 có BOM, mở được bằng Excel, tối đa 10.000 dòng. */
export function downloadAuditExport(params: ListAuditLogsParams = {}): Promise<DownloadResult> {
  const suffix = filterQuery(params);
  return apiDownload(suffix ? `/audit-logs/export?${suffix}` : "/audit-logs/export");
}

/** GET /audit-logs (chỉ SUPERVISOR): cũ nhất trước, tối đa 500 dòng mỗi lần gọi. */
export function listAuditLogs(params: ListAuditLogsParams = {}): Promise<AuditLog[]> {
  const query = new URLSearchParams();
  if (params.orderId) query.set("order_id", params.orderId);
  if (params.entityType) query.set("entity_type", params.entityType);
  for (const action of params.actions ?? []) query.append("action", action);
  if (params.staffId) query.set("staff_id", params.staffId);
  if (params.createdFrom) query.set("created_from", params.createdFrom);
  if (params.createdTo) query.set("created_to", params.createdTo);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  const suffix = query.toString();
  return apiRequest<AuditLog[]>(suffix ? `/audit-logs?${suffix}` : "/audit-logs");
}
