import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  createStaff,
  listStaff,
  lockStaff,
  resetStaffPassword,
  unlockStaff,
  updateStaff,
  type StaffDetail,
  type StaffRoleCode,
} from "../api/staff";
import { getAuth, updateStoredFullName, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Pagination } from "../components/Pagination";
import { StateCard } from "../components/StateCard";
import { Toast } from "../components/Toast";
import {
  CreateStaffDialog,
  EditStaffDialog,
  ResetPasswordDialog,
  ToggleLockDialog,
  type CreateStaffValues,
  type EditStaffValues,
} from "../components/StaffDialogs";
import { downloadCsv } from "../utils/csv";
import { staffErrorMessage } from "../utils/errorMessages";
import { formatShortDateTime } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";
import { ROLE_ORDER, initialsOf, roleLabel } from "../utils/roleLabels";

const PAGE_SIZE = 10;

type StatusFilter = "all" | "active" | "locked";
type RoleFilter = "all" | StaffRoleCode;
type Dialog =
  | { kind: "create" }
  | { kind: "edit"; staff: StaffDetail }
  | { kind: "reset"; staff: StaffDetail }
  | { kind: "lock"; staff: StaffDetail }
  | null;

const STATUS_FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "Tất cả" },
  { id: "active", label: "Đang hoạt động" },
  { id: "locked", label: "Đã khóa" },
];

/** Bỏ dấu để tìm "nguyen" ra "Nguyễn". */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replaceAll("đ", "d").replaceAll("Đ", "D").toLowerCase();
}

function sortStaff(rows: readonly StaffDetail[]): StaffDetail[] {
  return [...rows].sort((a, b) => {
    const byRole = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    return byRole !== 0 ? byRole : a.full_name.localeCompare(b.full_name, "vi");
  });
}

export function AdminStaffPage() {
  const selfId = getAuth()?.staff.id;
  const [rows, setRows] = useState<StaffDetail[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const hasLoaded = useRef(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else if (!hasLoaded.current) setState("loading");
    setError("");
    try {
      const data = await listStaff();
      setRows(sortStaff(data));
      hasLoaded.current = true;
      setStale(false);
      setState("ready");
    } catch (loadError) {
      setError(staffErrorMessage(loadError, "Dữ liệu nhân viên vừa thay đổi. Vui lòng tải lại."));
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
    document.title = "Quản trị nhân viên · NOVA POS";
    void load();
  }, [load]);

  const roleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.role] = (counts[row.role] ?? 0) + 1;
    return counts;
  }, [rows]);
  const activeCount = rows.filter((row) => row.is_active).length;

  const visibleRows = useMemo(() => {
    const needle = fold(search.trim());
    return rows.filter((row) => {
      if (roleFilter !== "all" && row.role !== roleFilter) return false;
      if (statusFilter === "active" && !row.is_active) return false;
      if (statusFilter === "locked" && row.is_active) return false;
      return !needle || fold(row.full_name).includes(needle) || fold(row.username).includes(needle);
    });
  }, [rows, roleFilter, statusFilter, search]);

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const firstIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = visibleRows.slice(firstIndex, firstIndex + PAGE_SIZE);

  function notify(message: string, type: FlashMessage["type"] = "success") {
    setToast({ message, type });
  }

  /** Chạy một thao tác ghi: thành công thì đóng hộp thoại và tải lại, 404/409 thì tải lại để thấy dữ liệu mới. */
  async function mutate(task: (key: string) => Promise<string>, conflict: string): Promise<string | null> {
    try {
      const successMessage = await task(createIdempotencyKey());
      setDialog(null);
      notify(successMessage);
      await load(true);
      return null;
    } catch (mutationError) {
      if (mutationError instanceof ApiError && (mutationError.status === 404 || mutationError.status === 409)) void load(true);
      return staffErrorMessage(mutationError, conflict);
    }
  }

  function handleCreate(values: CreateStaffValues) {
    return mutate(async (key) => {
      const created = await createStaff(values, key);
      return `Đã tạo tài khoản ${created.username}.`;
    }, "Tên đăng nhập này đã tồn tại. Vui lòng chọn tên khác.");
  }

  function handleEdit(staff: StaffDetail, values: EditStaffValues) {
    return mutate(async (key) => {
      const updated = await updateStaff(staff.id, values, key);
      if (staff.id === selfId && values.full_name) updateStoredFullName(updated.full_name);
      return "Đã lưu thay đổi.";
    }, "Không đổi được: tài khoản của chính bạn được bảo vệ hoặc dữ liệu vừa thay đổi. Danh sách đã được tải lại.");
  }

  function handleReset(staff: StaffDetail, newPassword: string) {
    return mutate(async (key) => {
      await resetStaffPassword(staff.id, newPassword, key);
      return `Đã đặt lại mật khẩu cho ${staff.full_name}.`;
    }, "Không đặt lại được mật khẩu của chính bạn tại đây. Hãy dùng Hồ sơ của tôi.");
  }

  function handleToggleLock(staff: StaffDetail) {
    return mutate(async (key) => {
      if (staff.is_active) {
        await lockStaff(staff.id, key);
        return `Đã khóa tài khoản ${staff.username}.`;
      }
      await unlockStaff(staff.id, key);
      return `Đã mở khóa tài khoản ${staff.username}.`;
    }, "Không đổi được trạng thái: bạn không thể khóa chính mình hoặc dữ liệu vừa thay đổi. Danh sách đã được tải lại.");
  }

  function exportCsv() {
    downloadCsv(
      "nhan-vien-nova-pos.csv",
      ["Họ tên", "Tên đăng nhập", "Vai trò", "Trạng thái", "Ngày tạo"],
      visibleRows.map((row) => [
        row.full_name,
        row.username,
        roleLabel(row.role),
        row.is_active ? "Đang hoạt động" : "Đã khóa",
        formatShortDateTime(row.created_at),
      ]),
    );
  }

  function chooseRole(role: RoleFilter) {
    setRoleFilter(role);
    setPage(1);
  }

  const filtered = roleFilter !== "all" || statusFilter !== "all" || search.trim() !== "";

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Quản trị · Nhân viên</p>
            <h1>Quản trị nhân viên</h1>
            <p>Tạo tài khoản, đổi vai trò, khóa hoặc đặt lại mật khẩu cho nhân viên của quán.</p>
          </div>
          <div className="nova-toolbar-actions">
            <Button variant="secondary" type="button" accessibleLabel="Tải lại danh sách nhân viên" busy={refreshing} busyLabel="Đang tải…" onClick={() => void load(true)}>
              <Icon name="refresh-cw" />
              Làm mới
            </Button>
            <Button variant="secondary" type="button" accessibleLabel="Xuất danh sách nhân viên ra file CSV" disabled={state !== "ready" || visibleRows.length === 0} onClick={exportCsv}>
              <Icon name="download" />
              Xuất danh sách
            </Button>
            <Button variant="primary" type="button" accessibleLabel="Thêm nhân viên mới" disabled={state !== "ready"} onClick={() => setDialog({ kind: "create" })}>
              <Icon name="plus" />
              Thêm nhân viên
            </Button>
          </div>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải danh sách nhân viên" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải danh sách nhân viên" message={error} onRetry={() => void load()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại danh sách nhân viên" busy={refreshing} onClick={() => void load(true)}>Thử lại</Button>
          </section>
        ) : null}

        {state === "ready" ? (
          <>
            <section className="nova-stat-grid" aria-label="Tổng quan nhân viên">
              <div className="nova-stat-card"><p>Tổng nhân viên</p><strong>{rows.length}</strong></div>
              <div className="nova-stat-card"><p>Đang hoạt động</p><strong>{activeCount}</strong></div>
              <div className="nova-stat-card"><p>Đã khóa</p><strong>{rows.length - activeCount}</strong></div>
              <div className="nova-stat-card"><p>Quản lý</p><strong>{roleCounts.SUPERVISOR ?? 0}</strong></div>
            </section>

            <div className="nova-history-toolbar">
              <div className="nova-search-bar nova-search-bar--compact">
                <Icon name="search" />
                <input
                  type="search"
                  value={search}
                  placeholder="Tìm theo tên hoặc tên đăng nhập"
                  aria-label="Tìm nhân viên"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <div className="nova-history-range" role="group" aria-label="Lọc theo trạng thái">
                {STATUS_FILTERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`nova-segment${statusFilter === item.id ? " nova-segment--active" : ""}`}
                    aria-pressed={statusFilter === item.id}
                    onClick={() => {
                      setStatusFilter(item.id);
                      setPage(1);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="nova-history-toolbar" role="group" aria-label="Lọc theo vai trò">
              <button type="button" className={`nova-pill${roleFilter === "all" ? " nova-pill--active" : ""}`} aria-pressed={roleFilter === "all"} onClick={() => chooseRole("all")}>
                Tất cả <strong>{rows.length}</strong>
              </button>
              {ROLE_ORDER.map((role) => (
                <button key={role} type="button" className={`nova-pill${roleFilter === role ? " nova-pill--active" : ""}`} aria-pressed={roleFilter === role} onClick={() => chooseRole(role)}>
                  {roleLabel(role)} <strong>{roleCounts[role] ?? 0}</strong>
                </button>
              ))}
            </div>

            {rows.length === 0 ? (
              <StateCard kind="empty" title="Chưa có nhân viên" message="Nhấn “Thêm nhân viên” để tạo tài khoản đầu tiên." />
            ) : visibleRows.length === 0 ? (
              <StateCard kind="empty" title="Không có nhân viên phù hợp" message={filtered ? "Thử đổi bộ lọc hoặc từ khóa tìm kiếm." : "Chưa có dữ liệu."} />
            ) : (
              <div className="nova-admin-table-wrap nova-history-table-wrap">
                <table className="nova-admin-table nova-history-table nova-staff-table">
                  <caption className="nova-visually-hidden">Danh sách nhân viên</caption>
                  <thead>
                    <tr>
                      <th scope="col">Nhân viên</th>
                      <th scope="col">Vai trò</th>
                      <th scope="col">Trạng thái</th>
                      <th scope="col">Ngày tạo</th>
                      <th scope="col"><span className="nova-visually-hidden">Thao tác</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row) => {
                      const isSelf = row.id === selfId;
                      return (
                        <tr key={row.id} data-testid="staff-row">
                          <td>
                            <div className="nova-audit-user">
                              <span className="nova-user-avatar" aria-hidden="true">{initialsOf(row.full_name)}</span>
                              <div>
                                <strong>{row.full_name}{isSelf ? <span className="nova-self-tag">Bạn</span> : null}</strong>
                                <p>{row.username}</p>
                              </div>
                            </div>
                          </td>
                          <td><span className="nova-entity-pill">{roleLabel(row.role)}</span></td>
                          <td>
                            <span className={`nova-status-badge ${row.is_active ? "nova-status--normal" : "nova-status--voided"}`}>
                              {row.is_active ? "Đang hoạt động" : "Đã khóa"}
                            </span>
                          </td>
                          <td className="nova-audit-time">{formatShortDateTime(row.created_at)}</td>
                          <td className="nova-admin-cell-actions">
                            <div className="nova-row-actions">
                              <Button variant="secondary" type="button" className="nova-order-line-action" accessibleLabel={`Sửa nhân viên ${row.full_name}`} onClick={() => setDialog({ kind: "edit", staff: row })}>Sửa</Button>
                              {isSelf ? (
                                <Link className="nova-button nova-button--secondary nova-order-line-action" to="/profile" aria-label="Đổi mật khẩu của bạn trong Hồ sơ của tôi">Đổi mật khẩu</Link>
                              ) : (
                                <>
                                  <Button variant="secondary" type="button" className="nova-order-line-action" accessibleLabel={`Đặt lại mật khẩu của ${row.full_name}`} onClick={() => setDialog({ kind: "reset", staff: row })}>Đặt lại mật khẩu</Button>
                                  <Button
                                    variant={row.is_active ? "danger" : "secondary"}
                                    type="button"
                                    className="nova-order-line-action"
                                    accessibleLabel={`${row.is_active ? "Khóa" : "Mở khóa"} tài khoản ${row.full_name}`}
                                    onClick={() => setDialog({ kind: "lock", staff: row })}
                                  >
                                    {row.is_active ? "Khóa" : "Mở khóa"}
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="nova-table-footer-bar">
                  <p>Hiển thị {firstIndex + 1}–{firstIndex + pageRows.length} trên {visibleRows.length} nhân viên</p>
                  <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} />
                </div>
              </div>
            )}
            <p className="nova-readonly-note">Tài khoản không bị xóa để giữ nguyên lịch sử đơn và nhật ký. Muốn ngừng dùng, hãy khóa tài khoản. Ảnh đại diện, số điện thoại và email chờ backend bổ sung.</p>
          </>
        ) : null}
      </main>

      {dialog?.kind === "create" ? <CreateStaffDialog onCancel={() => setDialog(null)} onSubmit={handleCreate} /> : null}
      {dialog?.kind === "edit" ? (
        <EditStaffDialog staff={dialog.staff} isSelf={dialog.staff.id === selfId} onCancel={() => setDialog(null)} onSubmit={(values) => handleEdit(dialog.staff, values)} />
      ) : null}
      {dialog?.kind === "reset" ? (
        <ResetPasswordDialog staff={dialog.staff} onCancel={() => setDialog(null)} onSubmit={(password) => handleReset(dialog.staff, password)} />
      ) : null}
      {dialog?.kind === "lock" ? (
        <ToggleLockDialog staff={dialog.staff} onCancel={() => setDialog(null)} onSubmit={() => handleToggleLock(dialog.staff)} />
      ) : null}
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}

