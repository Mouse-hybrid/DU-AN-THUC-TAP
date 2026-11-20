import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { usePermissions, type PermissionCode } from "../auth/permissions";
import { clearAuth, getAuth } from "../auth/storage";
import { initialsOf, roleLabel } from "../utils/roleLabels";
import { Icon } from "./Icon";
import { ReadyNotifier, ReadySoundToggle } from "./ReadyNotifier";

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

/** Mục điều hướng theo quyền của backend (GET /auth/me). Riêng Bàn và Lịch sử là khu phục vụ nên vẫn ẩn với tài khoản bếp. */
function navItemsFor(role: string | undefined, can: (code: PermissionCode) => boolean): NavItem[] {
  const items: NavItem[] = [];
  if (role !== "KITCHEN") {
    items.push(
      { to: "/tables", prefix: "/tables", label: "Bàn", icon: "grid-2x2" },
      { to: "/history", prefix: "/history", label: "Lịch sử", icon: "history" },
    );
  }
  if (can("VIEW_KDS")) items.push({ to: "/kitchen", prefix: "/kitchen", label: "Bếp", icon: "chef-hat" });
  if (can("MENU_WRITE")) items.push({ to: "/admin/menu/categories", prefix: "/admin/menu", label: "Thực đơn", icon: "utensils" });
  if (can("STAFF_MANAGE")) {
    items.push(
      { to: "/admin/staff", prefix: "/admin/staff", label: "Nhân viên", icon: "users" },
      { to: "/admin/roles", prefix: "/admin/roles", label: "Vai trò", icon: "shield-check" },
    );
  }
  if (can("LOYALTY_MANAGE")) items.push({ to: "/admin/members", prefix: "/admin/members", label: "Hội viên", icon: "user-round" });
  if (can("AUDIT_READ")) items.push({ to: "/admin/audit-logs", prefix: "/admin/audit-logs", label: "Nhật ký", icon: "scroll-text" });
  if (can("OUTLET_SETTINGS")) items.push({ to: "/admin/settings", prefix: "/admin/settings", label: "Cài đặt", icon: "key-round" });
  return items;
}

export function AppShell({ children, topbar }: AppShellProps) {
  const auth = getAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const navItems = navItemsFor(auth?.staff.role, can);
  const onProfile = location.pathname.startsWith("/profile");
  const activeItem = onProfile ? undefined : navItems.find((item) => location.pathname.startsWith(item.prefix)) ?? navItems[0];
  const home = activeItem?.to ?? navItems[0]?.to ?? "/tables";
  // Báo món sẵn sàng cho người phục vụ món (không cho bếp, không hiện trên màn bếp).
  const showReadyNotices = can("SERVE_FOOD") && auth?.staff.role !== "KITCHEN" && !location.pathname.startsWith("/kitchen");

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
            {showReadyNotices ? <ReadySoundToggle /> : null}
            <Link
              className={`nova-user-chip${onProfile ? " nova-user-chip--active" : ""}`}
              to="/profile"
              title="Hồ sơ của tôi"
              aria-current={onProfile ? "page" : undefined}
            >
              <span className="nova-user-avatar" aria-hidden="true">{initialsOf(auth?.staff.full_name)}</span>
              <span className="nova-user-chip-role">{roleLabel(auth?.staff.role) || auth?.staff.full_name}</span>
              <span className="nova-visually-hidden">{auth?.staff.full_name} · Hồ sơ của tôi</span>
            </Link>
            <button className="nova-icon-button" type="button" onClick={logout} aria-label="Đăng xuất">
              <Icon name="log-out" />
            </button>
          </div>
        </header>
        {children}
      </div>
      {showReadyNotices ? <ReadyNotifier /> : null}
    </div>
  );
}
