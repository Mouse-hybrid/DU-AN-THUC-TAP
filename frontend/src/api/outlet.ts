import { apiRequest } from "./client";
import type { components } from "./schema";

export type OutletSettings = components["schemas"]["OutletSettingsOut"];
export type OutletSettingsUpdate = components["schemas"]["OutletSettingsUpdate"];

/** GET /outlet/settings (quyền OUTLET_SETTINGS). */
export function getOutletSettings(): Promise<OutletSettings> {
  return apiRequest<OutletSettings>("/outlet/settings");
}

/** PATCH /outlet/settings: gửi trường nào đổi trường đó (chế độ gửi món QR, VAT, phí phục vụ). Có ghi nhật ký. */
export function updateOutletSettings(body: OutletSettingsUpdate, idempotencyKey: string): Promise<OutletSettings> {
  return apiRequest<OutletSettings, OutletSettingsUpdate>("/outlet/settings", { method: "PATCH", body, idempotencyKey });
}
