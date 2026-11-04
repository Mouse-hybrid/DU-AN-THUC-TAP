import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listAuditLogs, type AuditLog } from "../api/audit";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Pagination } from "../components/Pagination";
import { StateCard } from "../components/StateCard";
import {
  AUDIT_GROUPS,
  actionLabel,
  auditGroupMatches,
  entityLabel,
  summarizePayload,
  type AuditGroupId,
} from "../utils/auditLabels";
import { downloadCsv } from "../utils/csv";
import { orderErrorMessage } from "../utils/errorMessages";
import { formatDateOnly, formatFullDateTime, orderShortCode, startOfDayIso } from "../utils/format";
import { fetchAllPages } from "../utils/paging";

const PAGE_SIZE = 20;
const FETCH_PAGE_SIZE = 500;
const FETCH_MAX_PAGES = 4;

type RangeId = "today" | "7d" | "30d";

const RANGES: ReadonlyArray<{ id: RangeId; label: string; daysBack: number }> = [
  { id: "today", label: "Hôm nay", daysBack: 0 },
  { id: "7d", label: "7 ngày", daysBack: 6 },
  { id: "30d", label: "30 ngày", daysBack: 29 },
];

const ROLE_LABELS: Record<string, string> = {
  CASHIER: "Thu ngân",
  WAITER: "Phục vụ",
  KITCHEN: "Bếp",
  SUPERVISOR: "Quản lý",
};

function initialsOf(username: string | null): string {
  const text = (username ?? "").replace(/[^A-Za-z0-9]/g, "");
  return text ? text.slice(0, 2).toUpperCase() : "?";
}

export function AdminAuditLogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const orderId = searchParams.get("order") ?? "";

  const [rows, setRows] = useState<AuditLog[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<RangeId>("7d");
  const [group, setGroup] = useState<AuditGroupId>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const hasLoaded = useRef(false);
  const loadSeq = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    if (refresh) setRefreshing(true);
    else setState("loading");
    setError("");
    try {
      const daysBack = RANGES.find((candidate) => candidate.id === range)?.daysBack ?? 6;
      const createdFrom = startOfDayIso(daysBack);
      const result = await fetchAllPages(
        (offset, limit) => listAuditLogs({ orderId: orderId || undefined, createdFrom, limit, offset }),
        FETCH_PAGE_SIZE,
        FETCH_MAX_PAGES,
      );
      if (seq !== loadSeq.current) return;
      // API trả cũ nhất trước; nhật ký đọc mới nhất trước.
      setRows([...result.rows].reverse());
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
  }, [range, orderId]);

  useEffect(() => {
    document.title = "Nhật ký hệ thống · NOVA POS";
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => Object.fromEntries(AUDIT_GROUPS.map((item) => [item.id, rows.filter((row) => auditGroupMatches(item.id, row.entity_type)).length])) as Record<AuditGroupId, number>,
    [rows],
  );

  const visibleRows = useMemo(() => {
    const needle = query.trim().replace(/^#/, "").toLowerCase();
    return rows.filter((row) => {
      if (!auditGroupMatches(group, row.entity_type)) return false;
      if (!needle) return true;
      const haystack = [
        row.staff_username ?? "",
        ROLE_LABELS[row.staff_role ?? ""] ?? row.staff_role ?? "",
        actionLabel(row.action),
        row.action,
        entityLabel(row.entity_type),
        orderShortCode(row.entity_id),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, group, query]);

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const firstIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = visibleRows.slice(firstIndex, firstIndex + PAGE_SIZE);
  const rangeMeta = RANGES.find((candidate) => candidate.id === range) ?? RANGES[1];
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - (rangeMeta?.daysBack ?? 6));

  function clearOrderFilter() {
    setSearchParams({}, { replace: true });
    setPage(1);
  }

  function exportCsv() {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    downloadCsv(
      `nhat-ky-he-thong-${stamp}.csv`,
      ["Thời gian", "Người dùng", "Vai trò", "Hành động", "Đối tượng", "Mã đối tượng", "Chi tiết"],
      visibleRows.map((row) => [
        formatFullDateTime(row.created_at),
        row.staff_username ?? "Hệ thống",
        ROLE_LABELS[row.staff_role ?? ""] ?? row.staff_role ?? "",
        actionLabel(row.action),
        entityLabel(row.entity_type),
        row.entity_id,
        summarizePayload(row.payload).join("; "),
      ]),
    );
  }

  return (
    <AppShell
      topbar={
        <div>
          <p className="nova-topbar-label">NOVA Admin</p>
          <strong>Nhật ký hệ thống</strong>
        </div>
      }
    >
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Quản trị hệ thống</p>
            <h1>Nhật ký hệ thống</h1>
            <p>Mọi thao tác quan trọng trên POS và Backoffice · {rangeMeta?.label} · từ {formatDateOnly(fromDate)}</p>
          </div>
          <div className="nova-toolbar-actions">
            <div className="nova-history-range" role="group" aria-label="Khoảng thời gian">
              {RANGES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nova-segment${range === item.id ? " nova-segment--active" : ""}`}
                  aria-pressed={range === item.id}
                  onClick={() => {
                    setRange(item.id);
                    setPage(1);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Button
              variant="secondary"
              type="button"
              accessibleLabel="Tải lại nhật ký hệ thống"
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
              accessibleLabel="Xuất nhật ký ra file CSV"
              disabled={state !== "ready" || visibleRows.length === 0}
              onClick={exportCsv}
            >
              <Icon name="download" />
              Xuất nhật ký
            </Button>
          </div>
        </div>

        {orderId ? (
          <p className="nova-filter-chip" role="status">
            <span>Đang lọc theo đơn <strong>#{orderShortCode(orderId)}</strong></span>
            <button type="button" className="nova-filter-chip-clear" aria-label="Bỏ lọc theo đơn" onClick={clearOrderFilter}>
              <Icon name="x" />
            </button>
          </p>
        ) : null}

        {state === "loading" ? <StateCard kind="loading" title="Đang tải nhật ký" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải nhật ký" message={error} onRetry={() => void load()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại nhật ký" busy={refreshing} onClick={() => void load(true)}>Thử lại</Button>
          </section>
        ) : null}

        {state === "ready" ? (
          <>
            <div className="nova-history-toolbar">
              <div className="nova-search-bar nova-search-bar--compact nova-search-bar--wide">
                <Icon name="search" />
                <input
                  type="search"
                  autoComplete="off"
                  aria-label="Tìm người dùng hoặc đối tượng"
                  placeholder="Tìm người dùng, đối tượng…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPage(1);
                  }}
                />
              </div>
              {AUDIT_GROUPS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nova-pill${group === item.id ? " nova-pill--active" : ""}`}
                  aria-pressed={group === item.id}
                  onClick={() => {
                    setGroup(item.id);
                    setPage(1);
                  }}
                >
                  {item.label} <strong>{counts[item.id]}</strong>
                </button>
              ))}
            </div>

            {truncated ? (
              <p className="nova-readonly-note" role="status">
                Khoảng thời gian này có hơn {FETCH_PAGE_SIZE * FETCH_MAX_PAGES} thao tác, chỉ hiển thị phần đầu của khoảng. Hãy chọn khoảng ngắn hơn hoặc lọc theo đơn.
              </p>
            ) : null}

            {rows.length === 0 ? (
              <StateCard kind="empty" title="Chưa có thao tác nào" message="Không có nhật ký trong khoảng thời gian này." />
            ) : visibleRows.length === 0 ? (
              <StateCard kind="empty" title="Không có thao tác phù hợp" message="Hãy đổi từ khóa hoặc nhóm đối tượng." />
            ) : (
              <div className="nova-admin-table-wrap nova-history-table-wrap">
                <table className="nova-admin-table nova-history-table">
                  <caption className="nova-visually-hidden">Nhật ký thao tác</caption>
                  <thead>
                    <tr>
                      <th scope="col">Thời gian</th>
                      <th scope="col">Người dùng</th>
                      <th scope="col">Đối tượng</th>
                      <th scope="col">Hành động</th>
                      <th scope="col">Chi tiết</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row) => {
                      const details = summarizePayload(row.payload);
                      return (
                        <tr key={row.id}>
                          <td className="nova-audit-time">{formatFullDateTime(row.created_at)}</td>
                          <td>
                            <div className="nova-audit-user">
                              <span className="nova-user-avatar" aria-hidden="true">{initialsOf(row.staff_username)}</span>
                              <div>
                                <strong>{row.staff_username ?? "Hệ thống"}</strong>
                                {row.staff_role ? <p>{ROLE_LABELS[row.staff_role] ?? row.staff_role}</p> : null}
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="nova-entity-pill">{entityLabel(row.entity_type)}</span>
                            <span className="nova-audit-code">#{orderShortCode(row.entity_id)}</span>
                          </td>
                          <td><strong>{actionLabel(row.action)}</strong></td>
                          <td className="nova-audit-details">{details.length > 0 ? details.join(" · ") : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="nova-table-footer-bar">
                  <p>Hiển thị {firstIndex + 1}–{firstIndex + pageRows.length} trên {visibleRows.length} thao tác</p>
                  <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} />
                </div>
              </div>
            )}
          </>
        ) : null}

        <p className="nova-readonly-note">
          Nhật ký chỉ đọc. Các cột IP/thiết bị và kết quả chờ backend bổ sung.{" "}
          <Link to="/tables">Về sơ đồ bàn</Link>
        </p>
      </main>
    </AppShell>
  );
}
