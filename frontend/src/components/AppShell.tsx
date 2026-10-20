import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { clearAuth, getAuth } from "../auth/storage";
import { Icon } from "./Icon";

interface AppShellProps {
  children: ReactNode;
  topbar?: ReactNode;
}

export function AppShell({ children, topbar }: AppShellProps) {
  const auth = getAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isKitchenArea = location.pathname.startsWith("/kitchen");
  const home = isKitchenArea ? "/kitchen" : "/tables";

  function logout() {
    clearAuth();
    navigate("/login", { replace: true });
  }

  return (
    <div className="nova-app-shell">
      <aside className="nova-sidebar" aria-label="Điều hướng chính">
        <Link className="nova-brand-lockup nova-brand-lockup--compact" to={home} aria-label="NOVA POS">
          <span className="nova-brand-mark" aria-hidden="true">N</span>
          <span>NOVA POS</span>
        </Link>
        <nav className="nova-nav">
          <Link
            className="nova-nav-item nova-nav-item--active"
            to={home}
            aria-current={location.pathname.startsWith(home) ? "page" : undefined}
          >
            {isKitchenArea ? <span aria-hidden="true">K</span> : <Icon name="grid-2x2" />}
            <span>{isKitchenArea ? "Bếp" : "Bàn"}</span>
          </Link>
        </nav>
      </aside>

      <div className="nova-app-main">
        <header className="nova-topbar">
          {topbar ?? (
            <div>
              <p className="nova-topbar-label">Chi nhánh hiện tại</p>
              <strong>Chi nhánh Quận 1</strong>
            </div>
          )}
          <div className="nova-user-actions">
            <span className="nova-user-chip">{auth?.staff.full_name}</span>
            <button className="nova-icon-button" type="button" onClick={logout} aria-label="Đăng xuất">
              <Icon name="log-out" />
            </button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
