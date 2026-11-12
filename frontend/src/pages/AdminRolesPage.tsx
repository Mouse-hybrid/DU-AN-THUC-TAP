import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  listPermissions,
  resetPermissions,
  setPermissionRoles,
  type PermissionRule,
  type StaffRoleCode,
} from "../api/staff";
import { refreshPermissions } from "../auth/permissions";
import type { FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { StateCard } from "../components/StateCard";
import { Toast } from "../components/Toast";
import { permissionErrorMessage, staffErrorMessage } from "../utils/errorMessages";
import { createIdempotencyKey } from "../utils/idempotency";
import { ROLE_ORDER, roleLabel } from "../utils/roleLabels";

const CELL_CONFLICT = "Không đổi được ô này: hệ thống đang giữ cố định hoặc dữ liệu vừa thay đổi. Bảng quyền đã được tải lại.";
const RESET_CONFLICT = "Không khôi phục được vì dữ liệu vừa thay đổi. Bảng quyền đã được tải lại.";

function rolesText(roles: readonly StaffRoleCode[]): string {
  return roles.length === 0 ? "không vai trò nào" : ROLE_ORDER.filter((role) => roles.includes(role)).map(roleLabel).join(", ");
}

export function AdminRolesPage() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Quyền đang được lưu: khóa các ô còn lại và chặn bấm tiếp. */
  const [savingPermission, setSavingPermission] = useState<string | null>(null);
  /** Ô vừa tick, hiện ngay trong lúc chờ backend; lỗi thì tự trả về trạng thái cũ. */
  const [pending, setPending] = useState<{ permission: string; role: StaffRoleCode; allowed: boolean } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const hasLoaded = useRef(false);
  /** Chặn bấm đúp: state chỉ cập nhật sau lần render kế tiếp, ref thì có ngay. */
  const writing = useRef(false);

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
  const customizedCount = rules.filter((rule) => rule.customized).length;

  function notify(message: string, type: FlashMessage["type"] = "success") {
    setToast({ message, type });
  }

  /** Quyền của chính người đang sửa có thể vừa đổi nên cập nhật lại menu và nút của họ. */
  function syncOwnPermissions() {
    void refreshPermissions();
  }

  async function toggle(rule: PermissionRule, role: StaffRoleCode, allowed: boolean) {
    if (writing.current) return;
    writing.current = true;
    setSavingPermission(rule.permission);
    setPending({ permission: rule.permission, role, allowed });
    const next = ROLE_ORDER.filter((code) => (code === role ? allowed : rule.roles.includes(code)));
    try {
      setRules(await setPermissionRoles(rule.permission, next, createIdempotencyKey()));
      setStale(false);
      notify(`Đã ${allowed ? "cho phép" : "bỏ quyền của"} ${roleLabel(role)}: ${rule.description}.`);
      syncOwnPermissions();
    } catch (writeError) {
      notify(permissionErrorMessage(writeError, CELL_CONFLICT), "error");
      // Bảng đang hiển thị có thể đã lệch với server (ai đó vừa sửa, hoặc quyền của mình vừa đổi).
      if (writeError instanceof ApiError && writeError.status !== 0 && writeError.status < 500) void load(true);
    } finally {
      writing.current = false;
      setSavingPermission(null);
      setPending(null);
    }
  }

  async function handleReset() {
    if (writing.current) return;
    writing.current = true;
    setResetting(true);
    setResetError("");
    try {
      setRules(await resetPermissions(createIdempotencyKey()));
      setStale(false);
      setConfirmReset(false);
      notify("Đã khôi phục toàn bộ quyền về mặc định.");
      syncOwnPermissions();
    } catch (resetFailure) {
      setResetError(permissionErrorMessage(resetFailure, RESET_CONFLICT));
      if (resetFailure instanceof ApiError && resetFailure.status !== 0 && resetFailure.status < 500) void load(true);
    } finally {
      writing.current = false;
      setResetting(false);
    }
  }

  function closeResetDialog() {
    if (resetting) return;
    setConfirmReset(false);
    setResetError("");
  }

  const anyLocked = rules.some((rule) => rule.locked_roles.length > 0);

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Quản trị · Phân quyền</p>
            <h1>Vai trò &amp; quyền</h1>
            <p>Tick để cho phép một vai trò làm việc đó. Thay đổi có hiệu lực ngay, nhân viên không cần đăng nhập lại.</p>
          </div>
          <div className="nova-toolbar-actions">
            <Button variant="secondary" type="button" accessibleLabel="Tải lại bảng phân quyền" busy={refreshing} busyLabel="Đang tải…" disabled={savingPermission !== null} onClick={() => void load(true)}>
              <Icon name="refresh-cw" />
              Làm mới
            </Button>
            <Button
              variant="secondary"
              type="button"
              accessibleLabel="Khôi phục mặc định"
              disabled={state !== "ready" || customizedCount === 0 || savingPermission !== null}
              onClick={() => setConfirmReset(true)}
            >
              Khôi phục mặc định
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

              <p className="nova-roles-summary" role="status" data-testid="customized-summary">
                {customizedCount === 0 ? "Tất cả quyền đang ở mặc định của hệ thống." : `${customizedCount} quyền đã được sửa khác mặc định.`}
              </p>

              <div className="nova-admin-table-wrap nova-history-table-wrap">
                <table className="nova-admin-table nova-history-table nova-roles-table">
                  <caption className="nova-visually-hidden">Bảng quyền theo vai trò, tick để cho phép</caption>
                  <thead>
                    <tr>
                      <th scope="col">Quyền</th>
                      {ROLE_ORDER.map((role) => <th key={role} scope="col" className="nova-roles-cell">{roleLabel(role)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => {
                      const rowSaving = savingPermission === rule.permission;
                      return (
                        <tr key={rule.permission} data-testid="permission-row" data-permission={rule.permission} aria-busy={rowSaving}>
                          <th scope="row" className="nova-roles-name">
                            <strong>
                              {rule.description}
                              {rule.customized ? <span className="nova-status-badge nova-status--preparing nova-roles-badge" data-testid="customized-badge">Đã sửa</span> : null}
                            </strong>
                            <code>{rule.permission}</code>
                            {rule.customized ? <span className="nova-roles-default">Mặc định: {rolesText(rule.default_roles)}</span> : null}
                          </th>
                          {ROLE_ORDER.map((role) => {
                            const isPending = pending?.permission === rule.permission && pending.role === role;
                            const allowed = isPending ? pending.allowed : rule.roles.includes(role);
                            const locked = rule.locked_roles.includes(role);
                            const reason = "Hệ thống giữ cố định ô này nên không đổi được (cần cho hoạt động cốt lõi, ví dụ quản lý vẫn phải vào được màn phân quyền).";
                            return (
                              <td key={role} className="nova-roles-cell">
                                <label className={`nova-roles-check${locked ? " nova-roles-check--locked" : ""}`} title={locked ? reason : undefined}>
                                  <input
                                    type="checkbox"
                                    checked={allowed}
                                    disabled={locked || savingPermission !== null || resetting}
                                    aria-describedby={locked ? "nova-roles-locked-note" : undefined}
                                    onChange={(event) => void toggle(rule, role, event.target.checked)}
                                  />
                                  {locked ? <Icon name="lock" className="nova-icon nova-roles-lock" /> : null}
                                  <span className="nova-visually-hidden">
                                    {roleLabel(role)}: {rule.description}{locked ? " (cố định, không đổi được)" : ""}
                                  </span>
                                </label>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {anyLocked ? (
                <p className="nova-readonly-note" id="nova-roles-locked-note">
                  <Icon name="lock" className="nova-icon nova-roles-lock" /> Ô có biểu tượng khóa do hệ thống giữ cố định, không bỏ tick được (cần cho hoạt động cốt lõi, ví dụ quản lý vẫn phải vào được màn phân quyền).
                </p>
              ) : null}
            </>
          )
        ) : null}
      </main>

      {confirmReset ? (
        <ConfirmDialog
          title="Khôi phục quyền mặc định?"
          confirmLabel="Khôi phục"
          variant="danger"
          busy={resetting}
          onCancel={closeResetDialog}
          onConfirm={() => void handleReset()}
        >
          <p>Toàn bộ {customizedCount} quyền đã sửa sẽ quay về mặc định của hệ thống và có hiệu lực ngay cho mọi nhân viên.</p>
          {resetError ? <div className="nova-alert" role="alert">{resetError}</div> : null}
        </ConfirmDialog>
      ) : null}
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
