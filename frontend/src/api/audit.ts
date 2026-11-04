import { apiRequest } from "./client";
import type { components } from "./schema";

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
