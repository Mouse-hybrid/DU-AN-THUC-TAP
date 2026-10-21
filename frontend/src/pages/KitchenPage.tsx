import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getErrorMessage } from "../api/client";
import {
  listQueue,
  listStations,
  markReady,
  startCooking,
  type KitchenQueueResponse,
  type KitchenStationResponse,
} from "../api/kitchen";
import { hasRole } from "../auth/roles";
import { getAuth, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { KdsBoard } from "../components/KdsBoard";
import type { KdsAction } from "../components/KdsTicket";
import { StateCard } from "../components/StateCard";
import { Toast } from "../components/Toast";
import { useRealtime } from "../realtime/useRealtime";
import { createIdempotencyKey } from "../utils/idempotency";

type KitchenTab = "new" | "preparing" | "ready";

const TAB_CONFIG: Record<KitchenTab, { label: string; status: string | null; itemStatuses?: string[]; action: KdsAction }> = {
  new: { label: "Món mới", status: "QUEUED", action: "start" },
  preparing: { label: "Đang chế biến", status: "IN_PROGRESS", action: "ready" },
  ready: { label: "Sẵn sàng", status: null, itemStatuses: ["READY"], action: null },
};

function queueKey(tab: KitchenTab, stationId: string): string {
  return `${tab}:${stationId || "all"}`;
}

function actionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Bạn không có quyền cập nhật món này.";
    if (error.status === 404) return "Không tìm thấy món trong đơn.";
    if (error.status === 409) return "Trạng thái món vừa thay đổi. Danh sách đã được tải lại.";
    if (error.status === 0 && !navigator.onLine) return "Không thể cập nhật khi đang ngoại tuyến.";
  }
  return getErrorMessage(error);
}

export function KitchenPage() {
  const role = getAuth()?.staff.role;
  const canAct = hasRole(role, ["KITCHEN", "SUPERVISOR"]);
  const [activeTab, setActiveTab] = useState<KitchenTab>("new");
  const [stationId, setStationId] = useState("");
  const [stations, setStations] = useState<KitchenStationResponse>([]);
  const [queueCache, setQueueCache] = useState<Record<string, KitchenQueueResponse>>({});
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const [busyItemIds, setBusyItemIds] = useState<Set<string>>(() => new Set());
  const loadedKeys = useRef(new Set<string>());
  const loadsInFlight = useRef(new Set<string>());
  const activeKeyRef = useRef(queueKey(activeTab, stationId));
  const actionInFlight = useRef(new Set<string>());

  const currentKey = queueKey(activeTab, stationId);
  const entries = queueCache[currentKey] ?? [];
  const tabConfig = TAB_CONFIG[activeTab];

  const loadQueue = useCallback(async (tab: KitchenTab, selectedStationId: string, refresh = false) => {
    const key = queueKey(tab, selectedStationId);
    if (loadsInFlight.current.has(key)) return;
    loadsInFlight.current.add(key);
    const hasCachedData = loadedKeys.current.has(key);
    if (activeKeyRef.current === key) {
      if (refresh) setRefreshing(true);
      else if (!hasCachedData) setState("loading");
      setError("");
    }

    try {
      const config = TAB_CONFIG[tab];
      const data = await listQueue(config.status, selectedStationId || undefined, config.itemStatuses);
      setQueueCache((current) => ({ ...current, [key]: data }));
      loadedKeys.current.add(key);
      if (activeKeyRef.current === key) {
        setStale(false);
        setState("ready");
      }
    } catch (loadError) {
      if (activeKeyRef.current === key) {
        setError(navigator.onLine ? getErrorMessage(loadError) : "Không thể làm mới dữ liệu lúc này.");
        if (hasCachedData) {
          setStale(true);
          setState("ready");
        } else {
          setState("error");
        }
      }
    } finally {
      loadsInFlight.current.delete(key);
      if (activeKeyRef.current === key) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    activeKeyRef.current = currentKey;
  }, [currentKey]);

  useEffect(() => {
    document.title = "Màn bếp · NOVA POS";
    void listStations()
      .then(setStations)
      .catch((stationError: unknown) => {
        setToast({ message: `Không thể tải danh sách trạm. ${getErrorMessage(stationError)}`, type: "error" });
      });
  }, []);

  useEffect(() => {
    void loadQueue(activeTab, stationId);
  }, [activeTab, loadQueue, stationId]);

  const realtimeConnected = useRealtime({
    channel: "kitchen",
    onRefresh: () => void loadQueue(activeTab, stationId, true),
  });

  // Polling dự phòng: 5s khi chưa có WebSocket, 30s khi WebSocket đang chạy.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void loadQueue(activeTab, stationId, true);
      }
    }, realtimeConnected ? 30_000 : 5_000);
    return () => window.clearInterval(timer);
  }, [activeTab, loadQueue, realtimeConnected, stationId]);

  const activeStations = useMemo(() => stations.filter((station) => station.is_active), [stations]);

  async function updateItem(entry: KitchenQueueResponse[number]) {
    if (!tabConfig.action || actionInFlight.current.has(entry.order_item_id)) return;
    actionInFlight.current.add(entry.order_item_id);
    setBusyItemIds((current) => new Set(current).add(entry.order_item_id));
    try {
      const idempotencyKey = createIdempotencyKey();
      if (tabConfig.action === "start") {
        await startCooking(entry.order_id, entry.order_item_id, idempotencyKey);
      } else {
        await markReady(entry.order_id, entry.order_item_id, idempotencyKey);
      }
      await loadQueue(activeTab, stationId, true);
      setToast({
        message: tabConfig.action === "start" ? "Đã bắt đầu nấu món." : "Đã đánh dấu món hoàn thành.",
        type: "success",
      });
    } catch (actionError) {
      if (actionError instanceof ApiError && actionError.status === 409) {
        await loadQueue(activeTab, stationId, true);
      }
      setToast({ message: actionErrorMessage(actionError), type: "error" });
    } finally {
      actionInFlight.current.delete(entry.order_item_id);
      setBusyItemIds((current) => {
        const next = new Set(current);
        next.delete(entry.order_item_id);
        return next;
      });
    }
  }

  return (
    <AppShell
      topbar={
        <div>
          <p className="nova-topbar-label">NOVA Kitchen</p>
          <strong>Màn bếp</strong>
        </div>
      }
    >
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">KDS · Điều phối món</p>
            <h1>{tabConfig.label}</h1>
            <p>Theo dõi và cập nhật tiến độ chế biến theo từng trạm.</p>
          </div>
          <div className="nova-toolbar-actions">
            <div className="nova-field nova-field--compact">
              <label htmlFor="nova-station-filter">Trạm bếp</label>
              <select id="nova-station-filter" value={stationId} onChange={(event) => setStationId(event.target.value)}>
                <option value="">Tất cả trạm</option>
                {activeStations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}
              </select>
            </div>
            <Button
              variant="secondary"
              type="button"
              accessibleLabel="Làm mới hàng đợi bếp"
              busy={refreshing}
              busyLabel="Đang tải…"
              onClick={() => void loadQueue(activeTab, stationId, true)}
            >
              <Icon name="refresh-cw" />
              Làm mới
            </Button>
          </div>
        </div>

        <div className="nova-kds-tabs" role="tablist" aria-label="Trạng thái món">
          {(Object.keys(TAB_CONFIG) as KitchenTab[]).map((tab) => (
            <button
              key={tab}
              className={`nova-kds-tab${activeTab === tab ? " nova-kds-tab--active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
            >
              {TAB_CONFIG[tab].label}
            </button>
          ))}
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải hàng đợi" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? (
          <StateCard
            kind="error"
            title="Không thể tải hàng đợi"
            message={error}
            onRetry={() => void loadQueue(activeTab, stationId)}
          />
        ) : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button
              variant="secondary"
              type="button"
              accessibleLabel="Thử tải lại hàng đợi bếp"
              busy={refreshing}
              onClick={() => void loadQueue(activeTab, stationId, true)}
            >
              Thử lại
            </Button>
          </section>
        ) : null}
        {state === "ready" ? (
          <KdsBoard
            entries={entries}
            stations={stations}
            action={tabConfig.action}
            canAct={canAct}
            busyItemIds={busyItemIds}
            onAction={(entry) => void updateItem(entry)}
          />
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
