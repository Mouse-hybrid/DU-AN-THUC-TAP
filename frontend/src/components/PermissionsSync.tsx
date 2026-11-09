import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { FORBIDDEN_EVENT } from "../api/client";
import { refreshPermissions } from "../auth/permissions";

/** Đặt một lần trong <BrowserRouter>: làm mới quyền mỗi khi mở trang và mỗi khi backend trả 403. */
export function PermissionsSync() {
  const { pathname } = useLocation();

  useEffect(() => {
    void refreshPermissions();
  }, [pathname]);

  useEffect(() => {
    const onForbidden = () => void refreshPermissions();
    window.addEventListener(FORBIDDEN_EVENT, onForbidden);
    return () => window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
  }, []);

  return null;
}
