import { apiRequest } from "./client";
import type { components } from "./schema";

export type OutletSettings = components["schemas"]["OutletSettingsOut"];

/** GET /outlet/settings (quyền OUTLET_SETTINGS). */
export function getOutletSettings(): Promise<OutletSettings> {
  return apiRequest<OutletSettings>("/outlet/settings");
}

/** PATCH /outlet/settings: đổi chế độ gửi món QR. Có ghi nhật ký. */
export function updateOutletSettings(body: OutletSettings, idempotencyKey: string): Promise<OutletSettings> {
  return apiRequest<OutletSettings, OutletSettings>("/outlet/settings", { method: "PATCH", body, idempotencyKey });
}
