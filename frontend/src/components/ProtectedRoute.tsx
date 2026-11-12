import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { usePermissions, type PermissionCode } from "../auth/permissions";
import { getAuth, getHomePath } from "../auth/storage";
import { AppShell } from "./AppShell";
import { StateCard } from "./StateCard";

interface ProtectedRouteProps {
  /** "any": mọi tài khoản đã đăng nhập (hồ sơ cá nhân). */
  area: "pos" | "kitchen" | "admin" | "any";
  /** Quyền cần có để vào trang. Khu bếp mặc định cần VIEW_KDS; khu quản trị phải nêu rõ. */
  permission?: PermissionCode;
  children: ReactNode;
}

export function ProtectedRoute({ area, permission, children }: ProtectedRouteProps) {
  const auth = getAuth();
  const { ready, failed, can, refresh } = usePermissions();
  if (!auth) return <Navigate to={area === "kitchen" ? "/login?area=kitchen" : "/login"} replace />;

  const role = auth.staff.role;
  if (area === "any") return children;
  // Tài khoản bếp chỉ làm việc ở màn hình bếp.
  if (role === "KITCHEN" && area === "pos") return <Navigate to="/kitchen" replace />;

  // Quyền đến từ backend nên đợi biết quyền rồi mới quyết định, tránh chuyển hướng nhầm.
  if (!ready) {
    return (
      <AppShell>
        <main className="nova-content">
          {failed ? (
            <StateCard kind="error" title="Không thể kiểm tra quyền" message="Chưa lấy được quyền của tài khoản. Vui lòng thử lại." onRetry={() => void refresh()} />
          ) : (
            <StateCard kind="loading" title="Đang kiểm tra quyền" message="Vui lòng chờ trong giây lát." />
          )}
        </main>
      </AppShell>
    );
  }

  const required = permission ?? (area === "kitchen" ? "VIEW_KDS" : undefined);
  if (required && !can(required)) {
    // Tài khoản bếp bị gỡ quyền xem bếp không có trang nào khác để về, chuyển hướng sẽ bị lặp.
    if (area === "kitchen" && role === "KITCHEN") {
      return (
        <AppShell>
          <main className="nova-content">
            <StateCard kind="error" title="Chưa được cấp quyền" message="Tài khoản chưa có quyền dùng màn hình này. Vui lòng liên hệ quản lý." />
          </main>
        </AppShell>
      );
    }
    return <Navigate to={getHomePath(role)} replace />;
  }
  return children;
}
