import type { ReactNode } from "react";
import { usePermissions, type PermissionCode } from "../auth/permissions";

interface PermissionGuardProps {
  permission: PermissionCode;
  children: ReactNode;
}

/** Chỉ hiện nội dung khi người dùng có quyền (theo GET /auth/me), thay cho RoleGuard theo tên vai trò. */
export function PermissionGuard({ permission, children }: PermissionGuardProps) {
  return usePermissions().can(permission) ? children : null;
}
