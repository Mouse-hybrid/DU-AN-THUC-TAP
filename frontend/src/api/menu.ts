import { apiRequest } from "./client";
import type { components, paths } from "./schema";

export type MenuCategoryListResponse = paths["/api/v1/menu/categories"]["get"]["responses"][200]["content"]["application/json"];
export type MenuListResponse = paths["/api/v1/menu"]["get"]["responses"][200]["content"]["application/json"];

type MenuQuery = NonNullable<paths["/api/v1/menu"]["get"]["parameters"]["query"]>;

export function listCategories(activeOnly = true): Promise<MenuCategoryListResponse> {
  return apiRequest<MenuCategoryListResponse>(`/menu/categories?active_only=${String(activeOnly)}`);
}

export function listMenu({ available_only, category_id, q }: MenuQuery = {}): Promise<MenuListResponse> {
  const query = new URLSearchParams();
  if (available_only !== undefined) query.set("available_only", String(available_only));
  if (category_id) query.set("category_id", category_id);
  const keyword = q?.trim();
  if (keyword) query.set("q", keyword);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return apiRequest<MenuListResponse>(`/menu${suffix}`);
}

export type MenuCategory = components["schemas"]["MenuCategoryOut"];
export type MenuCategoryCreate = components["schemas"]["MenuCategoryCreate"];
export type MenuCategoryUpdate = components["schemas"]["MenuCategoryUpdate"];
export type MenuItem = components["schemas"]["MenuItemOut"];
export type MenuItemCreate = components["schemas"]["MenuItemCreate"];
export type MenuItemUpdate = components["schemas"]["MenuItemUpdate"];

export function createCategory(body: MenuCategoryCreate, idempotencyKey: string): Promise<MenuCategory> {
  return apiRequest<MenuCategory, MenuCategoryCreate>("/menu/categories", { method: "POST", body, idempotencyKey });
}

export function updateCategory(categoryId: string, body: MenuCategoryUpdate, idempotencyKey: string): Promise<MenuCategory> {
  return apiRequest<MenuCategory, MenuCategoryUpdate>(`/menu/categories/${encodeURIComponent(categoryId)}`, {
    method: "PATCH",
    body,
    idempotencyKey,
  });
}

export function createMenuItem(body: MenuItemCreate, idempotencyKey: string): Promise<MenuItem> {
  return apiRequest<MenuItem, MenuItemCreate>("/menu", { method: "POST", body, idempotencyKey });
}

export function updateMenuItem(itemId: string, body: MenuItemUpdate, idempotencyKey: string): Promise<MenuItem> {
  return apiRequest<MenuItem, MenuItemUpdate>(`/menu/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body,
    idempotencyKey,
  });
}
