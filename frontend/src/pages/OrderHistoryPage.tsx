import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { closeOrder, listOrders, type OrderSummaryRow } from "../api/orders";
import { usePermissions } from "../auth/permissions";
import type { FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { Pagination } from "../components/Pagination";
import { StateCard } from "../components/StateCard";
import { getStatusMeta } from "../components/status";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { downloadCsv } from "../utils/csv";
import { orderErrorMessage } from "../utils/errorMessages";
import {
  formatDateOnly,
  formatFullDateTime,
  formatShortDateTime,
  formatVnd,
  orderShortCode,
  startOfDayIso,
} from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";
import { fetchAllPages } from "../utils/paging";

const PAGE_SIZE = 20;
const FETCH_PAGE_SIZE = 200;
const FETCH_MAX_PAGES = 5;

type RangeId = "today" | "7d" | "30d";

const RANGES: ReadonlyArray<{ id: RangeId; label: string; daysBack: number }> = [
  { id: "today", label: "Hôm nay", daysBack: 0 },
  { id: "7d", label: "7 ngày", daysBack: 6 },
  { id: "30d", label: "30 ngày", daysBack: 29 },
];

type FilterId = "all" | "open" | "paid" | "closed";

/** Đơn chưa thanh toán xong: còn phục vụ hoặc đang chờ thanh toán. */
const OPEN_STATUSES = new Set(["NEW", "SENT", "SERVED", "BILLING"]);

const FILTERS: ReadonlyArray<{ id: FilterId; label: string; match: (status: string) => boolean }> = [
  { id: "all", label: "Tất cả", match: () => true },
  { id: "open", label: "Đang mở", match: (status) => OPEN_STATUSES.has(status) },
  { id: "paid", label: "Đã thanh toán", match: (status) => status === "PAID" },
  { id: "closed", label: "Đã đóng", match: (status) => status === "CLOSED" },
];

function isOpenForTable(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

function rangeSubtitle(range: RangeId): string {
  const meta = RANGES.find((candidate) => candidate.id === range) ?? RANGES[0];
  const from = new Date();
  from.setDate(from.getDate() - (meta?.daysBack ?? 0));
  return range === "today"
    ? `Hôm nay · ${formatDateOnly(new Date())}`
    : `${meta?.label ?? ""} gần nhất · từ ${formatDateOnly(from)}`;
}

export function OrderHistoryPage() {
  const { can } = usePermissions();
  const canClose = can("PROCESS_PAYMENT");
  const canViewAudit = can("AUDIT_READ");

  const [rows, setRows] = useState<OrderSummaryRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<RangeId>("today");
  const [filter, setFilter] = useState<FilterId>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [closing, setClosing] = useState<OrderSummaryRow | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState("");
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const hasLoaded = useRef(false);
  const loadSeq = useRef(0);
  const closeRunning = useRef(false);
  const closeKey = useRef("");

  const load = useCallback(async (refresh = false) => {
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    if (refresh) setRefreshing(true);
    else setState("loading");
    setError("");
    try {
      const daysBack = RANGES.find((candidate) => candidate.id === range)?.daysBack ?? 0;
      const createdFrom = startOfDayIso(daysBack);
      const result = await fetchAllPages(
        (offset, limit) => listOrders({ createdFrom, limit, offset }),
        FETCH_PAGE_SIZE,
        FETCH_MAX_PAGES,
      );
      if (seq !== loadSeq.current) return;
      setRows(result.rows);
      setTruncated(result.truncated);
      hasLoaded.current = true;
      setStale(false);
      setState("ready");
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      setError(orderErrorMessage(loadError));
      if (hasLoaded.current && refresh) {
        setStale(true);
        setState("ready");
      } else {
        setState("error");
      }
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }, [range]);

  useEffect(() => {
    document.title = "Lịch sử đơn · NOVA POS";
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((item) => [item.id, rows.filter((row) => item.match(row.status)).length])) as Record<FilterId, number>,
    [rows],
  );

  const visibleRows = useMemo(() => {
    const matcher = FILTERS.find((item) => item.id === filter)?.match ?? (() => true);
    const needle = query.trim().replace(/^#/, "").toLowerCase();
    return rows.filter((row) => {
      if (!matcher(row.status)) return false;
      if (!needle) return true;
      return orderShortCode(row.id).toLowerCase().includes(needle) || row.table_code.toLowerCase().includes(needle);
    });
  }, [rows, filter, query]);

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const firstIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = visibleRows.slice(firstIndex, firstIndex + PAGE_SIZE);

  function chooseRange(next: RangeId) {
    setRange(next);
    setPage(1);
  }

  function chooseFilter(next: FilterId) {
    setFilter(next);
    setPage(1);
  }

  function exportCsv() {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    downloadCsv(
      `lich-su-don-${stamp}.csv`,
      ["Mã đơn", "Bàn", "Thời gian", "Số món", "Giá trị (VND)", "Trạng thái"],
      visibleRows.map((row) => [
        `#${orderShortCode(row.id)}`,
        row.table_code,
        formatFullDateTime(row.created_at),
        String(row.item_count),
        String(Math.round(Number(row.subtotal)) || 0),
        getStatusMeta(row.status).label,
      ]),
    );
  }

  function askClose(row: OrderSummaryRow) {
    if (closeRunning.current) return;
    closeKey.current = createIdempotencyKey();
    setCloseError("");
    setClosing(row);
  }

  async function confirmClose() {
    if (!closing || closeRunning.current) return;
    closeRunning.current = true;
    setCloseBusy(true);
    setCloseError("");
    const target = closing;
    try {
      await closeOrder(target.id, closeKey.current);
      setClosing(null);
      await load(true);
      setToast({ message: `Đã đóng đơn #${orderShortCode(target.id)}.`, type: "success" });
    } catch (requestError) {
      if (requestError instanceof ApiError && (requestError.status === 409 || requestError.status === 404)) {
        setClosing(null);
        await load(true);
        setToast({ message: "Trạng thái đơn vừa thay đổi nên chưa thể đóng. Danh sách đã được tải lại.", type: "error" });
      } else {
        setCloseError(orderErrorMessage(requestError));
      }
    } finally {
      closeRunning.current = false;
      setCloseBusy(false);
    }
  }

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">POS · Lịch sử</p>
            <h1>Lịch sử đơn hàng</h1>
            <p>{rangeSubtitle(range)}</p>
          </div>
          <div className="nova-toolbar-actions">
            <div className="nova-history-range" role="group" aria-label="Khoảng thời gian">
              {RANGES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nova-segment${range === item.id ? " nova-segment--active" : ""}`}
                  aria-pressed={range === item.id}
                  onClick={() => chooseRange(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Button
              variant="secondary"
              type="button"
              accessibleLabel="Tải lại lịch sử đơn"
              busy={refreshing}
              busyLabel="Đang tải…"
              onClick={() => void load(true)}
            >
              <Icon name="refresh-cw" />
              Làm mới
            </Button>
            <Button
              variant="secondary"
              type="button"
              accessibleLabel="Xuất danh sách đơn ra file CSV"
              disabled={state !== "ready" || visibleRows.length === 0}
              onClick={exportCsv}
            >
              <Icon name="download" />
              Xuất danh sách
            </Button>
          </div>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải lịch sử đơn" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải lịch sử đơn" message={error} onRetry={() => void load()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại lịch sử đơn" busy={refreshing} onClick={() => void load(true)}>Thử lại</Button>
          </section>
        ) : null}

        {state === "ready" ? (
          <>
            <div className="nova-history-toolbar">
              <div className="nova-search-bar nova-search-bar--compact">
                <Icon name="search" />
                <input
                  type="search"
                  autoComplete="off"
                  aria-label="Tìm theo mã đơn hoặc bàn"
                  placeholder="Tìm mã đơn, bàn…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPage(1);
                  }}
                />
              </div>
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nova-pill${filter === item.id ? " nova-pill--active" : ""}`}
                  aria-pressed={filter === item.id}
                  onClick={() => chooseFilter(item.id)}
                >
                  {item.label} <strong>{counts[item.id]}</strong>
                </button>
              ))}
            </div>

            {truncated ? (
              <p className="nova-readonly-note" role="status">
                Khoảng thời gian này có hơn {FETCH_PAGE_SIZE * FETCH_MAX_PAGES} đơn, chỉ hiển thị các đơn mới nhất. Hãy chọn khoảng ngắn hơn để xem đủ.
              </p>
            ) : null}

            {rows.length === 0 ? (
              <StateCard kind="empty" title="Chưa có đơn trong khoảng này" message="Hãy chọn khoảng thời gian dài hơn." />
            ) : visibleRows.length === 0 ? (
              <StateCard kind="empty" title="Không có đơn phù hợp" message="Hãy đổi từ khóa hoặc bộ lọc trạng thái." />
            ) : (
              <div className="nova-admin-table-wrap nova-history-table-wrap">
                <table className="nova-admin-table nova-history-table">
                  <caption className="nova-visually-hidden">Danh sách đơn hàng</caption>
                  <thead>
                    <tr>
                      <th scope="col">Mã đơn</th>
                      <th scope="col">Bàn</th>
                      <th scope="col">Giờ</th>
                      <th scope="col" className="nova-num">Số món</th>
                      <th scope="col" className="nova-num">Giá trị</th>
                      <th scope="col">Trạng thái</th>
                      <th scope="col"><span className="nova-visually-hidden">Thao tác</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row) => (
                      <tr key={row.id}>
                        <td><strong className="nova-history-code">#{orderShortCode(row.id)}</strong></td>
                        <td>{row.table_code}</td>
                        <td>{formatShortDateTime(row.created_at)}</td>
                        <td className="nova-num">{row.item_count}</td>
                        <td className="nova-num"><strong>{formatVnd(row.subtotal)}</strong></td>
                        <td><StatusBadge status={row.status} /></td>
                        <td className="nova-admin-cell-actions">
                          <div className="nova-row-actions">
                            {isOpenForTable(row.status) ? (
                              <Link className="nova-button nova-button--secondary nova-order-line-action" to={`/tables/${encodeURIComponent(row.table_id)}`} aria-label={`Xem bàn ${row.table_code}`}>Xem bàn</Link>
                            ) : null}
                            {row.status === "PAID" && canClose ? (
                              <Button
                                variant="primary"
                                type="button"
                                className="nova-order-line-action"
                                accessibleLabel={`Đóng đơn ${orderShortCode(row.id)}`}
                                disabled={closeBusy}
                                onClick={() => askClose(row)}
                              >
                                Đóng đơn
                              </Button>
                            ) : null}
                            {canViewAudit ? (
                              <Link className="nova-button nova-button--secondary nova-order-line-action" to={`/admin/audit-logs?order=${encodeURIComponent(row.id)}`} aria-label={`Xem nhật ký đơn ${orderShortCode(row.id)}`}>Nhật ký</Link>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="nova-table-footer-bar">
                  <p>Hiển thị {firstIndex + 1}–{firstIndex + pageRows.length} trên {visibleRows.length} đơn</p>
                  <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} />
                </div>
              </div>
            )}
          </>
        ) : null}
      </main>

      {closing ? (
        <ConfirmDialog
          title="Đóng đơn?"
          confirmLabel="Đóng đơn"
          busy={closeBusy}
          onCancel={() => {
            if (!closeRunning.current) setClosing(null);
          }}
          onConfirm={() => void confirmClose()}
        >
          <p>Đơn <strong>#{orderShortCode(closing.id)}</strong> · bàn {closing.table_code} · {formatVnd(closing.subtotal)} đã thanh toán sẽ được chốt sổ và không thể chỉnh sửa nữa.</p>
          {closeError ? <div className="nova-alert" role="alert">{closeError}</div> : null}
        </ConfirmDialog>
      ) : null}
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
