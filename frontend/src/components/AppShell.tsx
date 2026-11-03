import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { clearAuth, getAuth } from "../auth/storage";
import { Icon } from "./Icon";

interface AppShellProps {
  children: ReactNode;
  topbar?: ReactNode;
}

interface NavItem {
  to: string;
  prefix: string;
  label: string;
  glyph?: string;
  icon?: string;
}

function navItemsFor(role: string | undefined): NavItem[] {
  if (role === "KITCHEN") return [{ to: "/kitchen", prefix: "/kitchen", label: "Bếp", glyph: "K" }];
  const items: NavItem[] = [{ to: "/tables", prefix: "/tables", label: "Bàn", icon: "grid-2x2" }];
  if (role === "SUPERVISOR") {
    items.push(
      { to: "/kitchen", prefix: "/kitchen", label: "Bếp", glyph: "K" },
      { to: "/admin/menu/categories", prefix: "/admin", label: "Thực đơn", glyph: "T" },
    );
  }
  return items;
}

export function AppShell({ children, topbar }: AppShellProps) {
  const auth = getAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const navItems = navItemsFor(auth?.staff.role);
  const activeItem = navItems.find((item) => location.pathname.startsWith(item.prefix)) ?? navItems[0];
  const home = activeItem?.to ?? "/tables";

  function logout() {
    clearAuth();
    navigate(location.pathname.startsWith("/kitchen") ? "/login?area=kitchen" : "/login", { replace: true });
  }

  return (
    <div className="nova-app-shell">
      <aside className="nova-sidebar" aria-label="Điều hướng chính">
        <Link className="nova-brand-lockup nova-brand-lockup--compact" to={home} aria-label="NOVA POS">
          <span className="nova-brand-mark" aria-hidden="true">N</span>
          <span>NOVA POS</span>
        </Link>
        <nav className="nova-nav">
          {navItems.map((item) => {
            const active = item === activeItem;
            return (
              <Link
                key={item.to}
                className={`nova-nav-item${active ? " nova-nav-item--active" : ""}`}
                to={item.to}
                aria-current={active ? "page" : undefined}
              >
                {item.icon ? <Icon name={item.icon} /> : <span aria-hidden="true">{item.glyph}</span>}
                <span>{item.label}</span>
              </Link>
            );
          })}
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
