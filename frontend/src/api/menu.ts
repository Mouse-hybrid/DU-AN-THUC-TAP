import { apiRequest } from "./client";
import type { paths } from "./schema";

export type MenuCategoryListResponse = paths["/api/v1/menu/categories"]["get"]["responses"][200]["content"]["application/json"];
export type MenuListResponse = paths["/api/v1/menu"]["get"]["responses"][200]["content"]["application/json"];

type MenuQuery = NonNullable<paths["/api/v1/menu"]["get"]["parameters"]["query"]>;

export function listCategories(activeOnly = true): Promise<MenuCategoryListResponse> {
  return apiRequest<MenuCategoryListResponse>(`/menu/categories?active_only=${String(activeOnly)}`);
}

export function listMenu({ available_only, category_id }: MenuQuery = {}): Promise<MenuListResponse> {
  const query = new URLSearchParams();
  if (available_only !== undefined) query.set("available_only", String(available_only));
  if (category_id) query.set("category_id", category_id);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return apiRequest<MenuListResponse>(`/menu${suffix}`);
}
