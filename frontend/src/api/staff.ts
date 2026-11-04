import { apiRequest } from "./client";
import type { components } from "./schema";
import type { TokenResponse } from "./types";

export type StaffDetail = components["schemas"]["StaffDetailOut"];
/** Vai trò hợp lệ khi tạo/sửa nhân viên (StaffOut.role ở login chỉ là string). */
export type StaffRoleCode = StaffDetail["role"];
export type StaffCreateBody = components["schemas"]["StaffCreate"];
export type StaffUpdateBody = components["schemas"]["StaffUpdate"];
export type PermissionRule = components["schemas"]["PermissionRuleOut"];
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

/** GET /staff/permissions: bảng quyền theo vai trò (chỉ đọc). */
export function listPermissions(): Promise<PermissionRule[]> {
  return apiRequest<PermissionRule[]>("/staff/permissions");
}

export function getMe(): Promise<MeInfo> {
  return apiRequest<MeInfo>("/auth/me");
}

/** POST /auth/change-password: backend thu hồi các phiên cũ và trả token mới, phải lưu lại bằng saveAuth. */
export function changePassword(body: ChangePasswordBody, idempotencyKey: string): Promise<TokenResponse> {
  return apiRequest<TokenResponse, ChangePasswordBody>("/auth/change-password", { method: "POST", body, idempotencyKey });
}
