import type { components } from "./schema";
import { apiRequest } from "./client";

export type Area = components["schemas"]["AreaOut"];

export function listAreas(activeOnly = true): Promise<Area[]> {
  return apiRequest<Area[]>(`/areas?active_only=${activeOnly ? "true" : "false"}`);
}
