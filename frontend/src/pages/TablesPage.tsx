import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, getErrorMessage } from "../api/client";
import { listAreas, type Area } from "../api/areas";
import { listTables, markClean, type TableListResponse } from "../api/tables";
import type { TableDashboardItem } from "../api/types";
import { consumeFlash, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { PermissionGuard } from "../components/PermissionGuard";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { getStatusMeta } from "../components/status";
import { formatOpenDuration } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";
import { useRealtime } from "../realtime/useRealtime";

const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "BILLING", "PAID", "CLEANING", "RESERVED", "DELAYED", "MERGED"] as const;
type TableStatus = (typeof TABLE_STATUSES)[number];
type StatusFilter = "ALL" | TableStatus;

interface TableCardProps {
  table: TableDashboardItem;
  mergedInto?: string | undefined;
  cleaning: boolean;
  onSelect: (table: TableDashboardItem) => void;
  onMarkClean: (table: TableDashboardItem) => void;
}

type TableTone = "available" | "occupied" | "billing" | "cleaning" | "neutral";

function toneOf(status: string): TableTone {
  if (status === "AVAILABLE") return "available";
  if (status === "OCCUPIED" || status === "DELAYED") return "occupied";
  if (status === "BILLING") return "billing";
  if (status === "CLEANING") return "cleaning";
  return "neutral";
}

function TableFigure({ seats }: { seats: number }) {
  const perSide = Math.max(1, Math.min(4, Math.ceil(seats / 2)));
  const chairs = Array.from({ length: perSide }, (_, index) => <i key={index} />);
  return (
    <span className="nova-table-figure" style={{ "--per-side": perSide } as CSSProperties} aria-hidden="true">
      <span className="nova-table-chairs">{chairs}</span>
      <span className="nova-table-top" />
      <span className="nova-table-chairs">{chairs}</span>
    </span>
  );
}

function TableCard({ table, mergedInto, cleaning, onSelect, onMarkClean }: TableCardProps) {
  const session = table.status === "MERGED"
    ? `Đã gộp vào bàn ${mergedInto ?? "khác"}`
    : table.opened_at
      ? `${table.guest_count ?? 0} khách · ${formatOpenDuration(table.opened_at)}`
      : "Chưa có phiên phục vụ";

  return (
    <article className={`nova-table-card nova-table-card--${toneOf(table.status)}`}>
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
        <TableFigure seats={table.seats} />
        <span className="nova-table-meta"><Icon name="users" />{table.seats} chỗ ngồi</span>
        <span className={`nova-table-session${table.opened_at ? "" : " nova-table-session--idle"}`}>
          {table.opened_at ? <Icon name="clock" /> : null}
          {session}
        </span>
      </button>
      {table.status === "CLEANING" ? (
        <PermissionGuard permission="TABLE_MARK_CLEAN">
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
        </PermissionGuard>
      ) : null}
    </article>
  );
}

const TABLE_STATS: { tone: TableTone; label: string }[] = [
  { tone: "available", label: "Trống" },
  { tone: "occupied", label: "Đang phục vụ" },
  { tone: "billing", label: "Chờ thanh toán" },
  { tone: "cleaning", label: "Đang dọn" },
];

const TABLE_EVENTS = new Set(["TABLE_SESSION_OPENED", "TABLE_STATUS_CHANGED", "ORDER_UPDATED"]);

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
  const [areas, setAreas] = useState<Area[]>([]);
  const [areaFilter, setAreaFilter] = useState("ALL");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(() => consumeFlash());
  const [cleaningTableIds, setCleaningTableIds] = useState<Set<string>>(() => new Set());
  const hasSuccessfulLoad = useRef(false);
  const markCleanInFlight = useRef(new Set<string>());
  const loadInFlight = useRef(false);

  const loadTables = useCallback(async (refresh = false) => {
    loadInFlight.current = true;
    if (refresh) setRefreshing(true);
    else if (!hasSuccessfulLoad.current) setState("loading");
    setError("");
    try {
      const [data, areaList] = await Promise.all([
        listTables(),
        listAreas().catch(() => null),
      ]);
      setTables(data);
      if (areaList) setAreas(areaList);
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
      loadInFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Sơ đồ bàn · NOVA POS";
    void loadTables();
  }, [loadTables]);

  // Tự cập nhật khi có bàn mở/đổi trạng thái hoặc order thay đổi; không chồng request đang chạy.
  const refreshInBackground = useCallback(() => {
    if (!loadInFlight.current && markCleanInFlight.current.size === 0) void loadTables(true);
  }, [loadTables]);

  const realtimeConnected = useRealtime({
    channel: "tables",
    filter: (event) => TABLE_EVENTS.has(event.type),
    onRefresh: refreshInBackground,
  });

  // Polling dự phòng: 5s khi chưa có WebSocket, 30s khi WebSocket đang chạy.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) refreshInBackground();
    }, realtimeConnected ? 30_000 : 5_000);
    return () => window.clearInterval(timer);
  }, [realtimeConnected, refreshInBackground]);

  const visibleTables = useMemo(
    () => tables.filter((table) => (filter === "ALL" || table.status === filter)
      && (areaFilter === "ALL" || (areaFilter === "NONE" ? !table.area_id : table.area_id === areaFilter))),
    [areaFilter, filter, tables],
  );

  const tableCodeById = useMemo(() => new Map(tables.map((table) => [table.id, table.code])), [tables]);

  /** Nhóm bàn theo khu: thứ tự khu lấy từ /areas, bàn chưa gán khu xếp cuối. */
  const groups = useMemo(() => {
    const byArea = new Map<string, TableDashboardItem[]>();
    for (const table of visibleTables) {
      const key = table.area_id ?? "NONE";
      byArea.set(key, [...(byArea.get(key) ?? []), table]);
    }
    const ordered: { id: string; name: string; tables: TableDashboardItem[] }[] = [];
    const seen = new Set<string>();
    for (const area of [...areas].sort((a, b) => a.sort_order - b.sort_order)) {
      const list = byArea.get(area.id);
      if (list) { ordered.push({ id: area.id, name: area.name, tables: list }); seen.add(area.id); }
    }
    for (const [key, list] of byArea) {
      if (key === "NONE" || seen.has(key)) continue;
      ordered.push({ id: key, name: list[0]?.area_name ?? "Khu khác", tables: list });
    }
    const none = byArea.get("NONE");
    if (none) ordered.push({ id: "NONE", name: "Chưa gán khu", tables: none });
    return ordered;
  }, [areas, visibleTables]);

  const hasAreas = areas.length > 0 || tables.some((table) => table.area_id);

  function selectTable(table: TableDashboardItem) {
    if (table.status === "AVAILABLE") {
      navigate(`/tables/${encodeURIComponent(table.id)}/open`);
      return;
    }
    if (table.status === "MERGED" && table.merged_into_table_id) {
      navigate(`/tables/${encodeURIComponent(table.merged_into_table_id)}`);
      return;
    }
    if (table.status === "OCCUPIED" || table.status === "BILLING") {
      navigate(`/tables/${encodeURIComponent(table.id)}`);
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
            {hasAreas ? (
              <div className="nova-field nova-field--compact">
                <label htmlFor="nova-area-filter">Khu vực</label>
                <select id="nova-area-filter" value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}>
                  <option value="ALL">Tất cả khu vực</option>
                  {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
                  {tables.some((table) => !table.area_id) ? <option value="NONE">Chưa gán khu</option> : null}
                </select>
              </div>
            ) : null}
            <button className="nova-button nova-button--secondary" type="button" onClick={() => void loadTables(true)} disabled={refreshing}>
              {refreshing ? <span className="nova-spinner" aria-hidden="true" /> : <Icon name="refresh-cw" />}
              <span>{refreshing ? "Đang tải…" : "Làm mới"}</span>
            </button>
          </div>
        </div>

        {state === "ready" && tables.length > 0 ? (
          <section className="nova-table-stats" aria-label="Thống kê bàn">
            {TABLE_STATS.map((stat) => (
              <div key={stat.tone} className={`nova-table-stat nova-table-stat--${stat.tone}`}>
                <strong aria-hidden="true">{tables.filter((table) => toneOf(table.status) === stat.tone).length}</strong>
                <div>
                  <span>{stat.label}</span>
                  <small>trên {tables.length} bàn</small>
                </div>
              </div>
            ))}
          </section>
        ) : null}

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
          <div aria-live="polite">
            {groups.map((group) => {
              const area = areas.find((candidate) => candidate.id === group.id);
              return (
                <section key={group.id} className="nova-area-section" aria-label={hasAreas ? `Khu ${group.name}` : "Danh sách bàn"} data-testid="area-section">
                  {hasAreas ? (
                    <header className="nova-area-header">
                      <h2>{group.name}</h2>
                      <p>
                        {group.tables.length} bàn
                        {area ? ` · ${area.status_counts["AVAILABLE"] ?? 0} trống · ${area.status_counts["OCCUPIED"] ?? 0} đang phục vụ` : ""}
                      </p>
                    </header>
                  ) : null}
                  <div className="nova-table-grid">
                    {group.tables.map((table) => (
                      <TableCard
                        key={table.id}
                        table={table}
                        mergedInto={table.merged_into_table_id ? tableCodeById.get(table.merged_into_table_id) : undefined}
                        cleaning={cleaningTableIds.has(table.id)}
                        onSelect={selectTable}
                        onMarkClean={(selected) => void cleanTable(selected)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
