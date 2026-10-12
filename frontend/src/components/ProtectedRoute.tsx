import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { getAuth } from "../auth/storage";

interface ProtectedRouteProps {
  area: "pos" | "kitchen";
  children: ReactNode;
}

export function ProtectedRoute({ area, children }: ProtectedRouteProps) {
  const auth = getAuth();
  if (!auth) return <Navigate to="/login" replace />;

  const isKitchen = auth.staff.role === "KITCHEN";
  if (isKitchen && area !== "kitchen") return <Navigate to="/kitchen" replace />;
  if (!isKitchen && area === "kitchen") return <Navigate to="/tables" replace />;
  return children;
}
