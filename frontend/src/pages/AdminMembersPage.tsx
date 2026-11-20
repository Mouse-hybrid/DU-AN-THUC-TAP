import { useCallback, useEffect, useMemo, useState } from "react";
import { getErrorMessage } from "../api/client";
import {
  adjustPoints,
  findCustomersByPhone,
  listCustomers,
  listPoints,
  updateCustomer,
  type Customer,
  type PointsEntry,
} from "../api/rewards";
import type { FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { FormDialog } from "../components/FormDialog";
import { Icon } from "../components/Icon";
import { StateCard } from "../components/StateCard";
import { Toast } from "../components/Toast";
import { formatShortDateTime } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";

const ENTRY_LABEL: Record<string, string> = {
  EARN: "Tích điểm",
  REDEEM: "Đổi điểm",
  ADJUST: "Điều chỉnh",
  REVERSAL: "Hoàn điểm (hoàn tiền)",
  EXPIRE: "Hết hạn",
};

function normalizePhone(value: string): string {
  return value.replace(/[\s.-]/g, "");
}

/** Quản lý hội viên (quyền LOYALTY_MANAGE, mặc định quản lý): danh sách, sổ điểm, điều chỉnh điểm, khóa. */
export function AdminMembersPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Customer[] | null>(null);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [ledger, setLedger] = useState<PointsEntry[] | null>(null);
  const [ledgerError, setLedgerError] = useState("");
  const [pointsText, setPointsText] = useState("");
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listCustomers());
      setState("ready");
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      setState("error");
    }
  }, []);

  useEffect(() => {
    document.title = "Hội viên · NOVA POS";
    void load();
  }, [load]);

  const visible = found ?? rows;
  const totalPoints = useMemo(() => rows.reduce((sum, row) => sum + row.points_balance, 0), [rows]);
  const activeCount = rows.filter((row) => row.is_active).length;

  async function runSearch() {
    const phone = normalizePhone(search);
    if (phone === "") {
      setFound(null);
      return;
    }
    if (!/^0\d{9}$/.test(phone)) {
      setToast({ message: "Số điện thoại gồm 10 chữ số, bắt đầu bằng 0.", type: "error" });
      return;
    }
    try {
      setFound(await findCustomersByPhone(phone));
    } catch (searchError) {
      setToast({ message: getErrorMessage(searchError), type: "error" });
    }
  }

  async function openMember(member: Customer) {
    setSelected(member);
    setLedger(null);
    setLedgerError("");
    setPointsText("");
    setReason("");
    setDialogError("");
    try {
      setLedger(await listPoints(member.id));
    } catch (ledgerLoadError) {
      setLedgerError(getErrorMessage(ledgerLoadError));
    }
  }

  async function refreshMember(memberId: string) {
    const [list, entries] = await Promise.all([listCustomers(), listPoints(memberId)]);
    setRows(list);
    setFound((current) => (current ? current.map((row) => list.find((item) => item.id === row.id) ?? row) : current));
    setSelected(list.find((item) => item.id === memberId) ?? null);
    setLedger(entries);
  }

  async function submitAdjust() {
    if (!selected) return;
    const points = Number(pointsText.trim());
    if (!Number.isInteger(points) || points === 0) {
      setDialogError("Nhập số điểm khác 0: số dương để cộng, số âm để trừ.");
      return;
    }
    if (reason.trim().length < 3) {
      setDialogError("Lý do cần ít nhất 3 ký tự.");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      await adjustPoints(selected.id, { points, reason: reason.trim() }, createIdempotencyKey());
      await refreshMember(selected.id);
      setPointsText("");
      setReason("");
      setToast({ message: `Đã ${points > 0 ? "cộng" : "trừ"} ${Math.abs(points)} điểm.`, type: "success" });
    } catch (adjustError) {
      setDialogError(getErrorMessage(adjustError));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!selected) return;
    setBusy(true);
    setDialogError("");
    try {
      await updateCustomer(selected.id, { is_active: !selected.is_active }, createIdempotencyKey());
      await refreshMember(selected.id);
      setToast({ message: selected.is_active ? "Đã khóa hội viên." : "Đã mở khóa hội viên.", type: "success" });
    } catch (toggleError) {
      setDialogError(getErrorMessage(toggleError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Quản trị · Điểm thưởng</p>
            <h1>Hội viên</h1>
            <p>Danh sách hội viên của cửa hàng, số điểm và lịch sử tích, đổi điểm. Hội viên được tạo ở màn thu tiền khi khách đồng ý.</p>
          </div>
          <div className="nova-toolbar-actions">
            <Button variant="secondary" type="button" accessibleLabel="Tải lại danh sách hội viên" onClick={() => { setFound(null); setSearch(""); void load(); }}>
              <Icon name="refresh-cw" />
              Làm mới
            </Button>
          </div>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải hội viên" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải hội viên" message={error} onRetry={() => void load()} /> : null}

        {state === "ready" ? (
          <>
            <section className="nova-stat-grid" aria-label="Tổng quan hội viên">
              <div className="nova-stat-card"><p>Tổng hội viên</p><strong>{rows.length}</strong></div>
              <div className="nova-stat-card"><p>Đang hoạt động</p><strong>{activeCount}</strong></div>
              <div className="nova-stat-card"><p>Đã khóa</p><strong>{rows.length - activeCount}</strong></div>
              <div className="nova-stat-card"><p>Tổng điểm đang có</p><strong>{totalPoints.toLocaleString("vi-VN")}</strong></div>
            </section>

            <form className="nova-history-toolbar" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
              <div className="nova-search-bar nova-search-bar--compact">
                <Icon name="search" />
                <input
                  type="search"
                  inputMode="tel"
                  value={search}
                  placeholder="Tìm theo số điện thoại (09xxxxxxxx)"
                  aria-label="Tìm hội viên theo số điện thoại"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    if (event.target.value.trim() === "") setFound(null);
                  }}
                />
              </div>
              <Button variant="secondary" type="submit" accessibleLabel="Tìm hội viên">Tìm</Button>
            </form>

            {visible.length === 0 ? (
              <StateCard
                kind="empty"
                title={found ? "Không có hội viên với số này" : "Chưa có hội viên"}
                message={found ? "Kiểm tra lại số điện thoại." : "Hội viên được tạo ở màn Tóm tắt đơn khi thu ngân đăng ký cho khách."}
              />
            ) : (
              <div className="nova-admin-table-wrap nova-history-table-wrap">
                <table className="nova-admin-table nova-history-table" data-testid="members-table">
                  <caption className="nova-visually-hidden">Danh sách hội viên</caption>
                  <thead>
                    <tr>
                      <th scope="col">Hội viên</th>
                      <th scope="col">Mã hội viên</th>
                      <th scope="col">Điểm</th>
                      <th scope="col">Trạng thái</th>
                      <th scope="col">Ngày đăng ký</th>
                      <th scope="col"><span className="nova-visually-hidden">Thao tác</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={row.id} data-testid="member-row">
                        <td>
                          <strong>{row.full_name || "Khách chưa có tên"}</strong>
                          <p className="nova-member-phone">{row.phone}</p>
                        </td>
                        <td>{row.member_code}</td>
                        <td><strong>{row.points_balance.toLocaleString("vi-VN")}</strong></td>
                        <td>
                          <span className={`nova-status-badge ${row.is_active ? "nova-status--normal" : "nova-status--voided"}`}>
                            {row.is_active ? "Đang hoạt động" : "Đã khóa"}
                          </span>
                        </td>
                        <td className="nova-audit-time">{formatShortDateTime(row.created_at)}</td>
                        <td className="nova-admin-cell-actions">
                          <Button variant="secondary" type="button" className="nova-order-line-action" accessibleLabel={`Xem điểm của ${row.full_name || row.member_code}`} onClick={() => void openMember(row)}>Xem điểm</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="nova-readonly-note">Hội viên không bị xóa để giữ lịch sử điểm. Muốn ngừng tích điểm cho khách, hãy khóa hội viên. Mọi điều chỉnh điểm đều ghi vào nhật ký.</p>
          </>
        ) : null}

        {selected ? (
          <FormDialog
            title={`${selected.full_name || "Khách chưa có tên"} · ${selected.points_balance.toLocaleString("vi-VN")} điểm`}
            titleId="nova-member-title"
            busy={busy}
            wide
            onCancel={() => { if (!busy) setSelected(null); }}
            onSubmit={() => void submitAdjust()}
            submitLabel="Điều chỉnh điểm"
            submitDisabled={pointsText.trim() === "" || reason.trim() === ""}
            error={dialogError}
          >
            <p>{selected.phone} · {selected.member_code} · {selected.is_active ? "Đang hoạt động" : "Đã khóa"}</p>
            <h3 className="nova-member-subtitle">Lịch sử điểm</h3>
            {ledgerError ? <div className="nova-alert" role="alert">{ledgerError}</div> : null}
            {ledger === null && !ledgerError ? <p className="nova-readonly-note">Đang tải lịch sử điểm…</p> : null}
            {ledger && ledger.length === 0 ? <p className="nova-readonly-note">Chưa có lần tích hay đổi điểm nào.</p> : null}
            {ledger && ledger.length > 0 ? (
              <div className="nova-member-ledger">
                <table className="nova-admin-table" data-testid="member-ledger">
                  <thead>
                    <tr><th scope="col">Thời gian</th><th scope="col">Loại</th><th scope="col">Điểm</th><th scope="col">Còn lại</th><th scope="col">Ghi chú</th></tr>
                  </thead>
                  <tbody>
                    {ledger.map((entry) => (
                      <tr key={entry.id}>
                        <td className="nova-audit-time">{formatShortDateTime(entry.created_at)}</td>
                        <td>{ENTRY_LABEL[entry.entry_type] ?? entry.entry_type}</td>
                        <td className={entry.points >= 0 ? "nova-points-plus" : "nova-points-minus"}>{entry.points > 0 ? `+${entry.points}` : entry.points}</td>
                        <td>{entry.balance_after}</td>
                        <td>
                          {entry.reason ?? (entry.order_id ? "Theo đơn hàng" : "")}
                          {entry.expires_at && entry.points > 0 ? ` · hết hạn ${new Date(entry.expires_at).toLocaleDateString("vi-VN")}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <h3 className="nova-member-subtitle">Điều chỉnh điểm</h3>
            <div className="nova-member-adjust">
              <label className="nova-field">
                <span>Số điểm (âm để trừ)</span>
                <input inputMode="numeric" value={pointsText} disabled={busy} onChange={(event) => { setPointsText(event.target.value); setDialogError(""); }} placeholder="vd 100 hoặc -20" />
              </label>
              <label className="nova-field">
                <span>Lý do (bắt buộc)</span>
                <input value={reason} maxLength={500} disabled={busy} onChange={(event) => { setReason(event.target.value); setDialogError(""); }} placeholder="vd Bù điểm đơn ngày 18/11" />
              </label>
            </div>
            <Button
              variant={selected.is_active ? "danger" : "secondary"}
              type="button"
              accessibleLabel={selected.is_active ? "Khóa hội viên" : "Mở khóa hội viên"}
              disabled={busy}
              onClick={() => void toggleActive()}
            >
              {selected.is_active ? "Khóa hội viên" : "Mở khóa hội viên"}
            </Button>
          </FormDialog>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
