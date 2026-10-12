import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRequest, getErrorMessage } from "../api/client";
import type {
  OpenSessionRequest,
  OpenSessionResponse,
  TableDashboardItem,
  TableDashboardResponse,
} from "../api/types";
import { setFlash } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Icon } from "../components/Icon";
import { StateCard } from "../components/StateCard";

function clampGuestCount(value: number): number {
  return Math.min(100, Math.max(1, Math.trunc(value || 1)));
}

export function OpenTablePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [table, setTable] = useState<TableDashboardItem | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [guestCount, setGuestCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const loadTable = useCallback(async () => {
    if (!id) {
      setError("Thiếu mã định danh bàn.");
      setState("error");
      return;
    }
    setState("loading");
    setError("");
    try {
      const tables = await apiRequest<TableDashboardResponse>("/tables");
      const found = tables.find((item) => item.id === id);
      if (!found) throw new Error("TABLE_NOT_FOUND");
      if (found.status !== "AVAILABLE") {
        setError("Bàn này không còn ở trạng thái trống. Vui lòng quay lại sơ đồ bàn.");
        setState("error");
        return;
      }
      setTable(found);
      setState("ready");
    } catch (loadError) {
      setError(loadError instanceof Error && loadError.message === "TABLE_NOT_FOUND" ? "Không tìm thấy bàn." : getErrorMessage(loadError));
      setState("error");
    }
  }, [id]);

  useEffect(() => {
    document.title = "Mở bàn · NOVA POS";
    void loadTable();
  }, [loadTable]);

  async function openTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id || !table || busy) return;
    const normalizedCount = clampGuestCount(guestCount);
    setGuestCount(normalizedCount);
    setSubmitError("");
    setBusy(true);
    const body: OpenSessionRequest = { guest_count: normalizedCount };
    const idempotencyKey = crypto.randomUUID();
    try {
      await apiRequest<OpenSessionResponse, OpenSessionRequest>(`/tables/${encodeURIComponent(id)}/open-session`, {
        method: "POST",
        body,
        idempotencyKey,
      });
      setFlash("Đã mở bàn", "success");
      navigate("/tables", { replace: true });
    } catch (requestError) {
      setSubmitError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      topbar={
        <Link className="nova-back-link" to="/tables">
          <Icon name="chevron-left" />
          Quay lại sơ đồ bàn
        </Link>
      }
    >
      <main className="nova-content nova-content--centered">
        <section className="nova-open-card">
          {state === "loading" ? <StateCard kind="loading" title="Đang tải thông tin bàn" message="Vui lòng chờ trong giây lát." /> : null}
          {state === "error" ? <StateCard kind="error" title="Không thể tải bàn" message={error} onRetry={() => void loadTable()} /> : null}
          {state === "ready" && table ? (
            <form className="nova-open-form" noValidate onSubmit={openTable}>
              <header className="nova-page-heading nova-page-heading--centered">
                <span className="nova-placeholder-icon" aria-hidden="true"><Icon name="door-open" /></span>
                <p className="nova-eyebrow">Mở phiên phục vụ</p>
                <h1>Thông tin phiên</h1>
              </header>

              {submitError ? <div className="nova-alert" role="alert">{submitError}</div> : null}

              <div className="nova-field nova-field--centered">
                <label htmlFor="nova-table-code">Bàn</label>
                <input id="nova-table-code" type="text" value={table.code} readOnly aria-readonly="true" />
                <p>{table.seats} chỗ ngồi</p>
              </div>

              <div className="nova-field nova-field--centered">
                <label htmlFor="nova-guest-count">Số khách</label>
                <div className="nova-stepper">
                  <button
                    className="nova-icon-button nova-icon-button--outlined"
                    type="button"
                    aria-label="Giảm số khách"
                    onClick={() => setGuestCount((count) => clampGuestCount(count - 1))}
                    disabled={busy || guestCount <= 1}
                  >
                    <Icon name="minus" />
                  </button>
                  <input
                    id="nova-guest-count"
                    name="guest_count"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    step={1}
                    value={guestCount}
                    onChange={(event) => setGuestCount(Number(event.target.value))}
                    onBlur={() => setGuestCount((count) => clampGuestCount(count))}
                    disabled={busy}
                    required
                  />
                  <button
                    className="nova-icon-button nova-icon-button--outlined"
                    type="button"
                    aria-label="Tăng số khách"
                    onClick={() => setGuestCount((count) => clampGuestCount(count + 1))}
                    disabled={busy || guestCount >= 100}
                  >
                    <Icon name="plus" />
                  </button>
                </div>
              </div>

              <button className="nova-button nova-button--primary nova-button--full" type="submit" disabled={busy}>
                {busy ? <span className="nova-spinner" aria-hidden="true" /> : null}
                <span>{busy ? "Đang mở bàn…" : "Mở bàn"}</span>
              </button>
            </form>
          ) : null}
        </section>
      </main>
    </AppShell>
  );
}
