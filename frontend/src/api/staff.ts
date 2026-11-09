import { apiRequest } from "./client";
import type { components } from "./schema";
import type { TokenResponse } from "./types";

export type StaffDetail = components["schemas"]["StaffDetailOut"];
/** Vai trò hợp lệ khi tạo/sửa nhân viên (StaffOut.role ở login chỉ là string). */
export type StaffRoleCode = StaffDetail["role"];
export type StaffCreateBody = components["schemas"]["StaffCreate"];
export type StaffUpdateBody = components["schemas"]["StaffUpdate"];
/**
 * Một dòng của bảng quyền (GET /staff/permissions).
 * default_roles, locked_roles, customized chưa có trong schema.d.ts trên main nên tạm khai báo tay theo hợp đồng backend đã báo.
 * Khi schema.d.ts có đủ các trường này, đổi về components["schemas"]["PermissionRuleOut"].
 */
export interface PermissionRule {
  permission: string;
  description: string;
  /** Các vai trò đang được phép (đã tính phần quản lý chỉnh). */
  roles: StaffRoleCode[];
  /** Mặc định của hệ thống, để biết ô nào đã bị sửa. */
  default_roles: StaffRoleCode[];
  /** Ô không được bỏ tick (ví dụ quản lý luôn có quyền quản lý nhân viên). */
  locked_roles: StaffRoleCode[];
  /** true khi `roles` khác `default_roles`. */
  customized: boolean;
}
export type MeInfo = components["schemas"]["MeOut"];
export type ChangePasswordBody = components["schemas"]["ChangePasswordRequest"];

/** GET /staff (chỉ SUPERVISOR, trong cùng cơ sở). Lọc vai trò/trạng thái làm ở client vì danh sách nhỏ. */
export function listStaff(): Promise<StaffDetail[]> {
  return apiRequest<StaffDetail[]>("/staff");
}

export function createStaff(body: StaffCreateBody, idempotencyKey: string): Promise<StaffDetail> {
  return apiRequest<StaffDetail, StaffCreateBody>("/staff", { method: "POST", body, idempotencyKey });
}

export function updateStaff(staffId: string, body: StaffUpdateBody, idempotencyKey: string): Promise<StaffDetail> {
  return apiRequest<StaffDetail, StaffUpdateBody>(`/staff/${encodeURIComponent(staffId)}`, { method: "PATCH", body, idempotencyKey });
}

export function lockStaff(staffId: string, idempotencyKey: string): Promise<StaffDetail> {
  return apiRequest<StaffDetail>(`/staff/${encodeURIComponent(staffId)}/lock`, { method: "POST", idempotencyKey });
}

export function unlockStaff(staffId: string, idempotencyKey: string): Promise<StaffDetail> {
  return apiRequest<StaffDetail>(`/staff/${encodeURIComponent(staffId)}/unlock`, { method: "POST", idempotencyKey });
}

export function resetStaffPassword(staffId: string, newPassword: string, idempotencyKey: string): Promise<StaffDetail> {
  return apiRequest<StaffDetail, { new_password: string }>(`/staff/${encodeURIComponent(staffId)}/reset-password`, {
    method: "POST",
    body: { new_password: newPassword },
    idempotencyKey,
  });
}

type RawPermissionRule = Pick<PermissionRule, "permission" | "description" | "roles"> & Partial<PermissionRule>;

/** Backend cũ chưa trả default_roles/locked_roles/customized thì coi như chưa sửa gì và không khóa ô nào. */
function normalizeRule(rule: RawPermissionRule): PermissionRule {
  return {
    permission: rule.permission,
    description: rule.description,
    roles: rule.roles,
    default_roles: rule.default_roles ?? rule.roles,
    locked_roles: rule.locked_roles ?? [],
    customized: rule.customized ?? false,
  };
}

/** GET /staff/permissions: bảng quyền theo vai trò. */
export async function listPermissions(): Promise<PermissionRule[]> {
  return (await apiRequest<RawPermissionRule[]>("/staff/permissions")).map(normalizeRule);
}

/**
 * PUT /staff/permissions/{permission}: `roles` là danh sách vai trò đầy đủ của dòng đó sau khi tick.
 * Backend trả về cả bảng mới. Quyền có hiệu lực ngay, nhân viên không cần đăng nhập lại.
 */
export async function setPermissionRoles(
  permission: string,
  roles: readonly StaffRoleCode[],
  idempotencyKey: string,
): Promise<PermissionRule[]> {
  const result = await apiRequest<RawPermissionRule[], { roles: readonly StaffRoleCode[] }>(
    `/staff/permissions/${encodeURIComponent(permission)}`,
    { method: "PUT", body: { roles }, idempotencyKey },
  );
  return result.map(normalizeRule);
}

/** POST /staff/permissions/reset: đưa toàn bộ bảng về mặc định, trả về bảng mới. */
export async function resetPermissions(idempotencyKey: string): Promise<PermissionRule[]> {
  return (await apiRequest<RawPermissionRule[]>("/staff/permissions/reset", { method: "POST", idempotencyKey })).map(normalizeRule);
}

export function getMe(): Promise<MeInfo> {
  return apiRequest<MeInfo>("/auth/me");
}

/** POST /auth/change-password: backend thu hồi các phiên cũ và trả token mới, phải lưu lại bằng saveAuth. */
export function changePassword(body: ChangePasswordBody, idempotencyKey: string): Promise<TokenResponse> {
  return apiRequest<TokenResponse, ChangePasswordBody>("/auth/change-password", { method: "POST", body, idempotencyKey });
}
