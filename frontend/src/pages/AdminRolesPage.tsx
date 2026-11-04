import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listPermissions, type PermissionRule } from "../api/staff";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { StateCard } from "../components/StateCard";
import { staffErrorMessage } from "../utils/errorMessages";
import { ROLE_ORDER, roleLabel } from "../utils/roleLabels";

export function AdminRolesPage() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoaded = useRef(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else if (!hasLoaded.current) setState("loading");
    setError("");
    try {
      setRules(await listPermissions());
      hasLoaded.current = true;
      setStale(false);
      setState("ready");
    } catch (loadError) {
      setError(staffErrorMessage(loadError, "Dữ liệu vừa thay đổi. Vui lòng tải lại."));
      if (hasLoaded.current) {
        setStale(true);
        setState("ready");
      } else {
        setState("error");
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Vai trò & quyền · NOVA POS";
    void load();
  }, [load]);

  const countByRole = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const role of ROLE_ORDER) counts[role] = rules.filter((rule) => rule.roles.includes(role)).length;
    return counts;
  }, [rules]);

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Quản trị · Phân quyền</p>
            <h1>Vai trò &amp; quyền</h1>
            <p>Mỗi vai trò được làm những việc nào trong hệ thống. Chỉ để xem, quyền do hệ thống quy định.</p>
          </div>
          <div className="nova-toolbar-actions">
            <Button variant="secondary" type="button" accessibleLabel="Tải lại bảng phân quyền" busy={refreshing} busyLabel="Đang tải…" onClick={() => void load(true)}>
              <Icon name="refresh-cw" />
              Làm mới
            </Button>
          </div>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải bảng phân quyền" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải bảng phân quyền" message={error} onRetry={() => void load()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại bảng phân quyền" busy={refreshing} onClick={() => void load(true)}>Thử lại</Button>
          </section>
        ) : null}

        {state === "ready" ? (
          rules.length === 0 ? (
            <StateCard kind="empty" title="Chưa có quy tắc phân quyền" message="Hệ thống chưa trả về quyền nào." />
          ) : (
            <>
              <section className="nova-stat-grid" aria-label="Số quyền theo vai trò">
                {ROLE_ORDER.map((role) => (
                  <div key={role} className="nova-stat-card">
                    <p>{roleLabel(role)}</p>
                    <strong>{countByRole[role] ?? 0}</strong>
                    <span>trên {rules.length} quyền</span>
                  </div>
                ))}
              </section>

              <div className="nova-admin-table-wrap nova-history-table-wrap">
                <table className="nova-admin-table nova-history-table nova-roles-table">
                  <caption className="nova-visually-hidden">Bảng quyền theo vai trò</caption>
                  <thead>
                    <tr>
                      <th scope="col">Quyền</th>
                      {ROLE_ORDER.map((role) => <th key={role} scope="col" className="nova-roles-cell">{roleLabel(role)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={rule.permission} data-testid="permission-row">
                        <th scope="row" className="nova-roles-name">
                          <strong>{rule.description}</strong>
                          <code>{rule.permission}</code>
                        </th>
                        {ROLE_ORDER.map((role) => {
                          const allowed = rule.roles.includes(role);
                          return (
                            <td key={role} className="nova-roles-cell">
                              {allowed ? (
                                <span className="nova-roles-yes"><Icon name="check" /><span className="nova-visually-hidden">{roleLabel(role)} được phép</span></span>
                              ) : (
                                <span className="nova-roles-no" aria-hidden="true">—<span className="nova-visually-hidden"> {roleLabel(role)} không được phép</span></span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="nova-readonly-note">Muốn đổi quyền của một người, hãy đổi vai trò của họ ở màn Nhân viên. Tự tạo vai trò mới hoặc chỉnh quyền từng vai trò chờ backend bổ sung.</p>
            </>
          )
        ) : null}
      </main>
    </AppShell>
  );
}
