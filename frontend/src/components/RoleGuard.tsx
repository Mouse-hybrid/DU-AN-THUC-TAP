import type { ReactNode } from "react";
import type { StaffRole } from "../auth/roles";
import { hasRole } from "../auth/roles";
import { getAuth } from "../auth/storage";

interface RoleGuardProps {
  allow: readonly StaffRole[];
  children: ReactNode;
}

export function RoleGuard({ allow, children }: RoleGuardProps) {
  const role = getAuth()?.staff.role;
  return hasRole(role, allow) ? children : null;
}
