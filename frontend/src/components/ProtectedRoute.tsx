import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { getAuth, getHomePath } from "../auth/storage";
import { hasRole } from "../auth/roles";

interface ProtectedRouteProps {
  /** "any": mọi vai trò đã đăng nhập (hồ sơ cá nhân). */
  area: "pos" | "kitchen" | "admin" | "any";
  children: ReactNode;
}

export function ProtectedRoute({ area, children }: ProtectedRouteProps) {
  const auth = getAuth();
  if (!auth) return <Navigate to={area === "kitchen" ? "/login?area=kitchen" : "/login"} replace />;

  const role = auth.staff.role;
  if (area === "any") return children;
  if (role === "KITCHEN" && area !== "kitchen") return <Navigate to="/kitchen" replace />;
  if (area === "kitchen" && !hasRole(role, ["KITCHEN", "SUPERVISOR"])) {
    return <Navigate to="/tables" replace />;
  }
  // Khu quản trị (thực đơn): chỉ SUPERVISOR. Backend vẫn kiểm tra quyền và trả 403 nếu role bị đổi.
  if (area === "admin" && !hasRole(role, ["SUPERVISOR"])) {
    return <Navigate to={getHomePath(role)} replace />;
  }
  return children;
}
