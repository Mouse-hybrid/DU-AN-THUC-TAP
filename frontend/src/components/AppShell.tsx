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

const ROLE_LABELS: Record<string, string> = {
  CASHIER: "Thu ngân",
  WAITER: "Phục vụ",
  KITCHEN: "Bếp",
  SUPERVISOR: "Quản lý",
};

function initialsOf(fullName: string | undefined): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";
  return (words.length === 1 ? first.slice(0, 2) : `${first.charAt(0)}${last.charAt(0)}`).toUpperCase();
}

function navItemsFor(role: string | undefined): NavItem[] {
  if (role === "KITCHEN") return [{ to: "/kitchen", prefix: "/kitchen", label: "Bếp", glyph: "K" }];
  const items: NavItem[] = [
    { to: "/tables", prefix: "/tables", label: "Bàn", icon: "grid-2x2" },
    { to: "/history", prefix: "/history", label: "Lịch sử", icon: "history" },
  ];
  if (role === "SUPERVISOR") {
    items.push(
      { to: "/kitchen", prefix: "/kitchen", label: "Bếp", glyph: "K" },
      { to: "/admin/menu/categories", prefix: "/admin/menu", label: "Thực đơn", glyph: "T" },
      { to: "/admin/audit-logs", prefix: "/admin/audit-logs", label: "Nhật ký", icon: "scroll-text" },
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
        <p className="nova-sidebar-footer">Phiên bản thử nghiệm</p>
      </aside>

      <div className="nova-app-main">
        <header className="nova-topbar">
          {topbar}
          <div className="nova-user-actions">
            <span className="nova-user-chip" title={auth?.staff.full_name}>
              <span className="nova-user-avatar" aria-hidden="true">{initialsOf(auth?.staff.full_name)}</span>
              <span>{ROLE_LABELS[auth?.staff.role ?? ""] ?? auth?.staff.full_name}</span>
              <span className="nova-visually-hidden">{auth?.staff.full_name}</span>
            </span>
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
