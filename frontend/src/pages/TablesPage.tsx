import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, getErrorMessage } from "../api/client";
import { listTables, markClean, type TableListResponse } from "../api/tables";
import type { TableDashboardItem } from "../api/types";
import { consumeFlash, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { RoleGuard } from "../components/RoleGuard";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { getStatusMeta } from "../components/status";
import { formatOpenDuration } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";

const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "BILLING", "PAID", "CLEANING", "RESERVED", "DELAYED", "MERGED"] as const;
type TableStatus = (typeof TABLE_STATUSES)[number];
type StatusFilter = "ALL" | TableStatus;

interface TableCardProps {
  table: TableDashboardItem;
  cleaning: boolean;
  onSelect: (table: TableDashboardItem) => void;
  onMarkClean: (table: TableDashboardItem) => void;
}

function TableCard({ table, cleaning, onSelect, onMarkClean }: TableCardProps) {
  const session = table.opened_at
    ? `${table.guest_count ?? 0} khách · ${formatOpenDuration(table.opened_at)}`
    : "Chưa có phiên phục vụ";

  return (
    <article className="nova-table-card">
      <button
        className="nova-table-card-select"
        type="button"
        onClick={() => onSelect(table)}
        aria-label={`Bàn ${table.code}, ${getStatusMeta(table.status).label}`}
      >
        <span className="nova-table-card-topline">
          <strong className="nova-table-code">{table.code}</strong>
          <StatusBadge status={table.status} />
        </span>
        <span className="nova-table-meta">{table.seats} chỗ ngồi</span>
        <span className="nova-table-session">{session}</span>
      </button>
      {table.status === "CLEANING" ? (
        <RoleGuard allow={["WAITER", "SUPERVISOR"]}>
          <Button
            className="nova-table-clean-action"
            variant="secondary"
            type="button"
            accessibleLabel={`Dọn xong bàn ${table.code}`}
            busy={cleaning}
            busyLabel="Đang cập nhật…"
            onClick={(event) => {
              event.stopPropagation();
              onMarkClean(table);
            }}
          >
            Dọn xong
          </Button>
        </RoleGuard>
      ) : null}
    </article>
  );
}

function markCleanErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Bạn không có quyền thực hiện thao tác này.";
    if (error.status === 404) return "Không tìm thấy bàn.";
    if (error.status === 409) return "Bàn không còn ở trạng thái đang dọn.";
  }
  return getErrorMessage(error);
}

export function TablesPage() {
  const navigate = useNavigate();
  const [tables, setTables] = useState<TableListResponse>([]);
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(() => consumeFlash());
  const [cleaningTableIds, setCleaningTableIds] = useState<Set<string>>(() => new Set());
  const hasSuccessfulLoad = useRef(false);
  const markCleanInFlight = useRef(new Set<string>());

  const loadTables = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else if (!hasSuccessfulLoad.current) setState("loading");
    setError("");
    try {
      const data = await listTables();
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

  async function cleanTable(table: TableDashboardItem) {
    if (markCleanInFlight.current.has(table.id)) return;
    markCleanInFlight.current.add(table.id);
    setCleaningTableIds((current) => new Set(current).add(table.id));
    try {
      const idempotencyKey = createIdempotencyKey();
      await markClean(table.id, idempotencyKey);
      await loadTables(true);
      setToast({ message: `Đã dọn xong bàn ${table.code}.`, type: "success" });
    } catch (cleanError) {
      if (cleanError instanceof ApiError && cleanError.status === 409) {
        await loadTables(true);
      }
      setToast({ message: markCleanErrorMessage(cleanError), type: "error" });
    } finally {
      markCleanInFlight.current.delete(table.id);
      setCleaningTableIds((current) => {
        const next = new Set(current);
        next.delete(table.id);
        return next;
      });
    }
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
                {TABLE_STATUSES.map((status) => <option key={status} value={status}>{getStatusMeta(status).label}</option>)}
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
            {visibleTables.map((table) => (
              <TableCard
                key={table.id}
                table={table}
                cleaning={cleaningTableIds.has(table.id)}
                onSelect={selectTable}
                onMarkClean={(selected) => void cleanTable(selected)}
              />
            ))}
          </section>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
