import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest, getErrorMessage } from "../api/client";
import type { TableDashboardItem, TableDashboardResponse } from "../api/types";
import { consumeFlash, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Icon } from "../components/Icon";
import { StateCard } from "../components/StateCard";
import { Toast } from "../components/Toast";
import { formatOpenDuration } from "../utils/format";

const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "BILLING", "PAID", "CLEANING", "RESERVED", "DELAYED", "MERGED"] as const;
type TableStatus = (typeof TABLE_STATUSES)[number];
type StatusFilter = "ALL" | TableStatus;

const STATUS_META: Record<TableStatus, { label: string; className: string }> = {
  AVAILABLE: { label: "Trống", className: "available" },
  OCCUPIED: { label: "Đang phục vụ", className: "occupied" },
  BILLING: { label: "Chờ thanh toán", className: "billing" },
  PAID: { label: "Đã thanh toán", className: "paid" },
  CLEANING: { label: "Đang dọn", className: "cleaning" },
  RESERVED: { label: "Đã đặt", className: "reserved" },
  DELAYED: { label: "Chậm phục vụ", className: "delayed" },
  MERGED: { label: "Đã gộp", className: "merged" },
};

function isTableStatus(status: string): status is TableStatus {
  return TABLE_STATUSES.some((knownStatus) => knownStatus === status);
}

function statusMeta(status: string) {
  return isTableStatus(status) ? STATUS_META[status] : { label: status, className: "merged" };
}

function TableCard({ table, onSelect }: { table: TableDashboardItem; onSelect: (table: TableDashboardItem) => void }) {
  const status = statusMeta(table.status);
  const session = table.opened_at
    ? `${table.guest_count ?? 0} khách · ${formatOpenDuration(table.opened_at)}`
    : "Chưa có phiên phục vụ";

  return (
    <button className="nova-table-card" type="button" onClick={() => onSelect(table)}>
      <span className="nova-table-card-topline">
        <strong className="nova-table-code">{table.code}</strong>
        <span className={`nova-status-badge nova-status--${status.className}`}>{status.label}</span>
      </span>
      <span className="nova-table-meta">{table.seats} chỗ ngồi</span>
      <span className="nova-table-session">{session}</span>
    </button>
  );
}

export function TablesPage() {
  const navigate = useNavigate();
  const [tables, setTables] = useState<TableDashboardResponse>([]);
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(() => consumeFlash());
  const hasSuccessfulLoad = useRef(false);

  const loadTables = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else if (!hasSuccessfulLoad.current) setState("loading");
    setError("");
    try {
      const data = await apiRequest<TableDashboardResponse>("/tables");
      setTables(data);
      hasSuccessfulLoad.current = true;
      setStale(false);
      setState("ready");
    } catch (loadError) {
      const message = navigator.onLine ? getErrorMessage(loadError) : "Không thể làm mới dữ liệu lúc này.";
      setError(message);
      if (hasSuccessfulLoad.current) {
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
    document.title = "Sơ đồ bàn · NOVA POS";
    void loadTables();
  }, [loadTables]);

  const visibleTables = useMemo(
    () => (filter === "ALL" ? tables : tables.filter((table) => table.status === filter)),
    [filter, tables],
  );

  function selectTable(table: TableDashboardItem) {
    if (table.status === "AVAILABLE") {
      navigate(`/tables/${encodeURIComponent(table.id)}/open`);
      return;
    }
    setToast({ message: "Chi tiết bàn sắp có.", type: "info" });
  }

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">POS · Quản lý bàn</p>
            <h1>Sơ đồ bàn</h1>
            <p>Chọn bàn trống để mở phiên phục vụ mới.</p>
          </div>
          <div className="nova-toolbar-actions">
            <div className="nova-field nova-field--compact">
              <label htmlFor="nova-status-filter">Trạng thái</label>
              <select id="nova-status-filter" value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}>
                <option value="ALL">Tất cả trạng thái</option>
                {TABLE_STATUSES.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}
              </select>
            </div>
            <button className="nova-button nova-button--secondary" type="button" onClick={() => void loadTables(true)} disabled={refreshing}>
              {refreshing ? <span className="nova-spinner" aria-hidden="true" /> : <Icon name="refresh-cw" />}
              <span>{refreshing ? "Đang tải…" : "Làm mới"}</span>
            </button>
          </div>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải sơ đồ bàn" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải sơ đồ bàn" message={error} onRetry={() => void loadTables()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div>
              <strong>Dữ liệu có thể đã cũ</strong>
              <p>{error}</p>
            </div>
            <button className="nova-button nova-button--secondary" type="button" onClick={() => void loadTables(true)} disabled={refreshing}>
              Thử lại
            </button>
          </section>
        ) : null}
        {state === "ready" && visibleTables.length === 0 ? (
          <StateCard kind="empty" title="Không có bàn phù hợp" message="Hãy chọn trạng thái khác hoặc tải lại dữ liệu." onRetry={() => void loadTables(true)} />
        ) : null}
        {state === "ready" && visibleTables.length > 0 ? (
          <section className="nova-table-grid" aria-live="polite">
            {visibleTables.map((table) => <TableCard key={table.id} table={table} onSelect={selectTable} />)}
          </section>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
