import { useEffect, useRef, useState } from "react";
import { getAuditSummary, type AuditSummary } from "../api/audit";
import { actionLabel } from "../utils/auditLabels";
import { orderErrorMessage } from "../utils/errorMessages";
import { Button } from "./Button";

interface AuditSummaryPanelProps {
  createdFrom: string;
  orderId: string;
  reloadToken: number;
}

const ROLE_LABELS: Record<string, string> = {
  CASHIER: "Thu ngân",
  WAITER: "Phục vụ",
  KITCHEN: "Bếp",
  SUPERVISOR: "Quản lý",
};

/** Báo cáo tổng hợp nhật ký (GET /audit-logs/summary). */
export function AuditSummaryPanel({ createdFrom, orderId, reloadToken }: AuditSummaryPanelProps) {
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  function load() {
    const current = seq.current + 1;
    seq.current = current;
    setLoading(true);
    setError("");
    getAuditSummary({ createdFrom, orderId: orderId || undefined })
      .then((data) => { if (seq.current === current) setSummary(data); })
      .catch((e: unknown) => { if (seq.current === current) setError(orderErrorMessage(e)); })
      .finally(() => { if (seq.current === current) setLoading(false); });
  }

  useEffect(load, [createdFrom, orderId, reloadToken]);

  const maxDay = Math.max(1, ...(summary?.by_day ?? []).map((day) => day.count));
  const topActions = [...(summary?.by_action ?? [])].sort((a, b) => b.count - a.count).slice(0, 8);
  const maxAction = Math.max(1, ...topActions.map((action) => action.count));
  const staff = [...(summary?.by_staff ?? [])].sort((a, b) => b.count - a.count).slice(0, 8);

  return (
    <section className="nova-audit-summary" aria-label="Báo cáo tổng hợp" data-testid="audit-summary">
      {loading && !summary ? <p className="nova-readonly-note">Đang tải báo cáo…</p> : null}
      {error ? (
        <div className="nova-stale-notice" role="alert">
          <div><strong>Không tải được báo cáo</strong><p>{error}</p></div>
          <Button variant="secondary" type="button" accessibleLabel="Thử tải lại báo cáo" busy={loading} onClick={load}>Thử lại</Button>
        </div>
      ) : null}
      {summary ? (
        <>
          <div className="nova-audit-kpis">
            <div className="nova-audit-kpi"><span>Tổng thao tác</span><strong data-testid="audit-total">{summary.total}</strong></div>
            <div className="nova-audit-kpi nova-audit-kpi--warn"><span>Thao tác ngoại lệ</span><strong data-testid="audit-exceptions">{summary.exception_total}</strong></div>
          </div>
          <div className="nova-audit-columns">
            <div>
              <h3>Theo ngày</h3>
              <ul className="nova-audit-bars" aria-label="Số thao tác theo ngày">
                {summary.by_day.map((day) => (
                  <li key={day.date}>
                    <span>{day.date.slice(5).split("-").reverse().join("/")}</span>
                    <i style={{ width: `${Math.max(4, (day.count / maxDay) * 100)}%` }} />
                    <b>{day.count}</b>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Theo hành động</h3>
              <ul className="nova-audit-bars" aria-label="Số thao tác theo hành động">
                {topActions.map((action) => (
                  <li key={action.action} className={action.is_exception ? "nova-audit-bars--warn" : ""}>
                    <span>{actionLabel(action.action)}</span>
                    <i style={{ width: `${Math.max(4, (action.count / maxAction) * 100)}%` }} />
                    <b>{action.count}</b>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Theo nhân viên</h3>
              <ul className="nova-audit-staff" aria-label="Số thao tác theo nhân viên">
                {staff.map((row) => (
                  <li key={row.staff_id ?? "system"}>
                    <span>{row.username ?? "Khách QR / hệ thống"}{row.role ? ` · ${ROLE_LABELS[row.role] ?? row.role}` : ""}</span>
                    <b>{row.count}</b>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
