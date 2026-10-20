import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { getAuth } from "../auth/storage";
import { hasRole } from "../auth/roles";

interface ProtectedRouteProps {
  area: "pos" | "kitchen";
  children: ReactNode;
}

export function ProtectedRoute({ area, children }: ProtectedRouteProps) {
  const auth = getAuth();
  if (!auth) return <Navigate to="/login" replace />;

  const role = auth.staff.role;
  if (role === "KITCHEN" && area !== "kitchen") return <Navigate to="/kitchen" replace />;
  if (area === "kitchen" && !hasRole(role, ["KITCHEN", "SUPERVISOR"])) {
    return <Navigate to="/tables" replace />;
  }
  return children;
}
