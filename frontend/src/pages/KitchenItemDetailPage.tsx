import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, getErrorMessage } from "../api/client";
import {
  listQueue,
  listStations,
  markReady,
  startCooking,
  type KitchenQueueResponse,
  type KitchenStationResponse,
} from "../api/kitchen";
import { getOrder, type OrderDetail, type OrderItemDetail } from "../api/orders";
import { usePermissions } from "../auth/permissions";
import type { FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { MenuThumb } from "../components/MenuThumb";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { overrideKindsFor, useItemOverrides } from "../components/useItemOverrides";
import { useRealtime } from "../realtime/useRealtime";
import { kitchenActionErrorMessage } from "../utils/errorMessages";
import { formatShortDateTime } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";
import { SLA_LABELS, ticketCode } from "../utils/kds";

type KitchenQueueEntry = KitchenQueueResponse[number];
type KdsStep = "start" | "ready";

const KITCHEN_EVENTS = new Set([
  "KITCHEN_QUEUE_UPDATED",
  "ORDER_ITEM_STATUS_CHANGED",
  "ORDER_ITEM_VOIDED",
  "ORDER_ITEM_REFIRED",
]);

const LOCKED_ORDER_STATUSES = new Set(["BILLING", "PAID", "CLOSED"]);

function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "Không tìm thấy món hoặc đơn này. Món có thể đã bị xóa khỏi đơn.";
    if (error.status === 403) return "Bạn không có quyền xem món này.";
  }
  return navigator.onLine ? getErrorMessage(error) : "Không thể tải dữ liệu khi đang ngoại tuyến.";
}

/** Giải thích vì sao giám sát chưa hủy / làm lại được món (backend chặn theo trạng thái đơn và món). */
function overrideUnavailableReason(orderStatus: string, itemStatus: string): string {
  if (LOCKED_ORDER_STATUSES.has(orderStatus)) return "Đơn đã yêu cầu thanh toán nên không thể hủy hoặc làm lại món.";
  if (itemStatus === "VOIDED") return "Món này đã được hủy.";
  if (itemStatus === "REFIRED") return "Món này đã được gửi lại cho bếp làm lại.";
  return "Món đang ở trạng thái này chưa thể hủy hoặc làm lại. Hủy được khi món chưa xong; làm lại được sau khi món đã giao cho khách.";
}

/** Bước kế tiếp của bếp, suy ra từ trạng thái phiếu (cùng quy tắc với màn bếp). */
function nextStep(entry: KitchenQueueEntry | null, item: OrderItemDetail): KdsStep | null {
  if (!entry || item.status === "VOIDED" || item.status === "REFIRED") return null;
  if (entry.item_status === "READY") return null;
  if (entry.status === "QUEUED") return "start";
  if (entry.status === "IN_PROGRESS") return "ready";
  return null;
}

function modifierText(item: OrderItemDetail): string {
  return item.modifiers.map((modifier) => `${modifier.group_name}: ${modifier.option_name}`).join("; ");
}

export function KitchenItemDetailPage() {
  const { orderId = "", itemId = "" } = useParams();
  const { can } = usePermissions();
  const canCook = can("KITCHEN_ACTION");
  const canOverride = can("OVERRIDE");

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [entry, setEntry] = useState<KitchenQueueEntry | null>(null);
  const [stations, setStations] = useState<KitchenStationResponse>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const hasLoaded = useRef(false);
  const loading = useRef(false);
  const actionInFlight = useRef(new Set<string>());

  const loadData = useCallback(async (refresh = false) => {
    if (!orderId || !itemId) {
      setError("Thiếu mã đơn hoặc mã món.");
      setState("error");
      return;
    }
    if (loading.current) return;
    loading.current = true;
    if (refresh) setRefreshing(true);
    else if (!hasLoaded.current) setState("loading");
    try {
      const detail = await getOrder(orderId);
      const found = detail.items.find((candidate) => candidate.id === itemId);
      if (!found) throw new ApiError("Không tìm thấy món trong đơn.", 404);
      // Phiếu bếp chỉ để lấy mốc thời gian và trạm; lỗi ở đây không làm hỏng màn.
      const queue = await listQueue({ item_status: [found.status] }).catch(() => null);
      setOrder(detail);
      if (queue) setEntry(queue.find((candidate) => candidate.order_item_id === itemId) ?? null);
      hasLoaded.current = true;
      setError("");
      setStale(false);
      setState("ready");
    } catch (loadError) {
      setError(loadErrorMessage(loadError));
      if (hasLoaded.current) {
        setStale(true);
        setState("ready");
      } else {
        setState("error");
      }
    } finally {
      loading.current = false;
      setRefreshing(false);
    }
  }, [itemId, orderId]);

  useEffect(() => {
    document.title = "Chi tiết món · NOVA POS";
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void listStations().then(setStations).catch(() => undefined);
  }, []);

  const realtimeConnected = useRealtime({
    channel: "kitchen",
    filter: (event) => KITCHEN_EVENTS.has(event.type),
    onRefresh: () => {
      if (actionInFlight.current.size === 0) void loadData(true);
    },
  });

  // Polling dự phòng như màn bếp: 5s khi chưa có WebSocket, 30s khi WebSocket đang chạy.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine && actionInFlight.current.size === 0) {
        void loadData(true);
      }
    }, realtimeConnected ? 30_000 : 5_000);
    return () => window.clearInterval(timer);
  }, [loadData, realtimeConnected]);

  const overrides = useItemOverrides({
    reload: () => loadData(true),
    notify: setToast,
    inFlight: actionInFlight,
  });

  const item = order?.items.find((candidate) => candidate.id === itemId) ?? null;
  const step = item ? nextStep(entry, item) : null;
  const stationName = entry ? (stations.find((station) => station.id === entry.station_id)?.name ?? "Chưa xác định") : "—";

  async function runStep(kind: KdsStep) {
    if (!order || !item || actionInFlight.current.has(item.id)) return;
    actionInFlight.current.add(item.id);
    setCooking(true);
    try {
      const key = createIdempotencyKey();
      if (kind === "start") await startCooking(order.id, item.id, key);
      else await markReady(order.id, item.id, key);
      await loadData(true);
      setToast({ message: kind === "start" ? "Đã bắt đầu nấu món." : "Đã đánh dấu món hoàn thành.", type: "success" });
    } catch (actionError) {
      if (actionError instanceof ApiError && actionError.status === 409) await loadData(true);
      setToast({ message: kitchenActionErrorMessage(actionError), type: "error" });
    } finally {
      actionInFlight.current.delete(item.id);
      setCooking(false);
    }
  }

  const overrideKinds = order && item ? overrideKindsFor(order.status, item.status) : [];
  const slaLate = entry !== null && entry.status === "IN_PROGRESS" && entry.sla_status !== "NORMAL";
  const slaLabel = entry
    ? `${SLA_LABELS[entry.sla_status] ?? entry.sla_status}${typeof entry.elapsed_minutes === "number" ? ` ${Math.floor(entry.elapsed_minutes)} phút` : ""}`
    : "";

  const steps = [
    { label: "Nhận phiếu", at: entry?.queued_at },
    { label: "Bắt đầu chế biến", at: entry?.started_at },
    { label: "Sẵn sàng", at: entry?.done_at },
  ];

  return (
    <AppShell
      topbar={
        <div>
          <p className="nova-topbar-label">NOVA Kitchen</p>
          <strong>Chi tiết món</strong>
        </div>
      }
    >
      <main className="nova-content">
        <Link className="nova-back-link nova-back-link--inline" to="/kitchen">
          <Icon name="arrow-left" />
          Quay lại bảng điều khiển
        </Link>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải chi tiết món" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? (
          <StateCard kind="error" title="Không thể tải chi tiết món" message={error} onRetry={() => void loadData()} />
        ) : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại chi tiết món" busy={refreshing} onClick={() => void loadData(true)}>
              Thử lại
            </Button>
          </section>
        ) : null}

        {state === "ready" && order && item ? (
          <>
            <header className="nova-page-heading nova-kds-detail-heading">
              <p className="nova-eyebrow">KDS · Chi tiết</p>
              <h1>{item.menu_item_name} · Bàn {order.table_code}</h1>
              <p>
                Phiếu #{ticketCode(order.table_code, order.id)}
                {entry ? ` · nhận lúc ${formatShortDateTime(entry.queued_at)}` : ` · đơn tạo lúc ${formatShortDateTime(order.created_at)}`}
              </p>
            </header>

            <div className="nova-kds-detail-layout">
              <section className="nova-kds-detail-card" aria-labelledby="nova-kds-detail-item-title">
                <MenuThumb name={item.menu_item_name} className="nova-kds-detail-photo" />
                <div className="nova-kds-detail-title">
                  <h2 id="nova-kds-detail-item-title">{item.menu_item_name} × {item.quantity}</h2>
                  <div className="nova-kds-detail-badges">
                    {slaLate && entry ? <StatusBadge status={entry.sla_status} label={slaLabel} /> : null}
                    <StatusBadge status={item.status} />
                  </div>
                </div>
                <dl className="nova-kds-detail-list">
                  <div><dt>Ghi chú</dt><dd>{item.note?.trim() ? item.note : "Không có"}</dd></div>
                  {item.modifiers.length > 0 ? <div><dt>Tùy chọn</dt><dd>{modifierText(item)}</dd></div> : null}
                  <div><dt>Trạm</dt><dd>{stationName}</dd></div>
                </dl>
              </section>

              <div className="nova-kds-detail-side">
                <section className="nova-kds-detail-card" aria-labelledby="nova-kds-progress-title">
                  <h2 id="nova-kds-progress-title">Tiến trình</h2>
                  <ol className="nova-kds-steps">
                    {steps.map((entryStep, index) => (
                      <li key={entryStep.label} className={`nova-kds-step${entryStep.at ? " nova-kds-step--done" : ""}`}>
                        <span className="nova-kds-step-mark" aria-hidden="true">
                          {entryStep.at ? <Icon name="check" /> : index + 1}
                        </span>
                        <span className="nova-kds-step-label">{entryStep.label}</span>
                        <span className="nova-kds-step-time">{entryStep.at ? formatShortDateTime(entryStep.at) : "—"}</span>
                      </li>
                    ))}
                  </ol>
                  {!entry ? <p className="nova-readonly-note">Món chưa có phiếu bếp đang hoạt động nên chưa có mốc thời gian.</p> : null}
                  {step && canCook ? (
                    <Button
                      variant="primary"
                      type="button"
                      className="nova-kds-detail-button"
                      accessibleLabel={step === "start" ? `Bắt đầu nấu ${item.menu_item_name}` : `Đánh dấu sẵn sàng ${item.menu_item_name}`}
                      busy={cooking}
                      busyLabel="Đang cập nhật…"
                      disabled={overrides.busy}
                      onClick={() => void runStep(step)}
                    >
                      {step === "start" ? "Bắt đầu nấu" : (<><Icon name="check" />Đánh dấu sẵn sàng</>)}
                    </Button>
                  ) : null}
                </section>

                {canOverride ? (
                  <section className="nova-kds-detail-card" aria-labelledby="nova-kds-manage-title">
                    <div>
                      <h2 id="nova-kds-manage-title">Thao tác quản lý</h2>
                      <p className="nova-kds-detail-hint">Chỉ giám sát được hủy hoặc làm lại món. Mọi thao tác đều được ghi vào nhật ký.</p>
                    </div>
                    {overrideKinds.length === 0 ? (
                      <p className="nova-readonly-note">{overrideUnavailableReason(order.status, item.status)}</p>
                    ) : (
                      <div className="nova-kds-manage-actions">
                        {overrideKinds.includes("void") ? (
                          <Button
                            variant="danger"
                            type="button"
                            className="nova-kds-detail-button"
                            accessibleLabel={`Hủy món ${item.menu_item_name}`}
                            disabled={cooking || overrides.busy}
                            onClick={() => overrides.request("void", order.id, item)}
                          >
                            Hủy món
                          </Button>
                        ) : null}
                        {overrideKinds.includes("refire") ? (
                          <Button
                            variant="secondary"
                            type="button"
                            className="nova-kds-detail-button"
                            accessibleLabel={`Làm lại món ${item.menu_item_name}`}
                            disabled={cooking || overrides.busy}
                            onClick={() => overrides.request("refire", order.id, item)}
                          >
                            Làm lại món
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </section>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </main>
      {overrides.dialog}
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
