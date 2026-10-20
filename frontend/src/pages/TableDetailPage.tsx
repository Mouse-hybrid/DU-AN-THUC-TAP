import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, getErrorMessage } from "../api/client";
import { pickupItem, serveItem, type OrderItemDetail } from "../api/orders";
import { getTable, type TableDetailResponse } from "../api/tables";
import type { FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { OrderLineItem } from "../components/OrderLineItem";
import { RoleGuard } from "../components/RoleGuard";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { formatOpenDuration, formatVnd } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";

type ItemAction = "pickup" | "served";

function tableDetailError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Bạn không có quyền thực hiện thao tác này.";
    if (error.status === 404) return "Không tìm thấy bàn, đơn hoặc món cần thao tác.";
    if (error.status === 409) return "Trạng thái món vừa thay đổi. Dữ liệu đã được tải lại.";
    if (error.status === 422) return error.message || "Dữ liệu gửi lên chưa hợp lệ.";
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

function noopItemUpdate() {
  // Chi tiết bàn chỉ hiển thị món; chỉnh sửa thực hiện ở màn gọi món.
}

function noopItemRemove() {
  // Chi tiết bàn chỉ hiển thị món; chỉnh sửa thực hiện ở màn gọi món.
}

export function TableDetailPage() {
  const { id: tableId } = useParams<{ id: string }>();
  const [table, setTable] = useState<TableDetailResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyItemIds, setBusyItemIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const hasLoaded = useRef(false);
  const loadInFlight = useRef(false);
  const mutationInFlight = useRef(new Set<string>());

  const loadTable = useCallback(async (refresh = false) => {
    if (!tableId || loadInFlight.current) return;
    loadInFlight.current = true;
    if (refresh) setRefreshing(true);
    else if (!hasLoaded.current) setState("loading");
    setError("");
    try {
      const detail = await getTable(tableId);
      setTable(detail);
      hasLoaded.current = true;
      setStale(false);
      setState("ready");
    } catch (loadError) {
      setError(navigator.onLine ? tableDetailError(loadError) : "Không thể làm mới dữ liệu lúc này.");
      if (hasLoaded.current) {
        setStale(true);
        setState("ready");
      } else {
        setState("error");
      }
    } finally {
      loadInFlight.current = false;
      setRefreshing(false);
    }
  }, [tableId]);

  useEffect(() => {
    document.title = "Chi tiết bàn · NOVA POS";
    void loadTable();
  }, [loadTable]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible"
        && navigator.onLine
        && mutationInFlight.current.size === 0
        && !loadInFlight.current
      ) {
        void loadTable(true);
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadTable]);

  const readyCount = useMemo(
    () => table?.orders.reduce(
      (count, order) => count + order.items.filter((item) => item.status === "READY").length,
      0,
    ) ?? 0,
    [table],
  );

  async function updateItemStatus(orderId: string, item: OrderItemDetail, action: ItemAction) {
    if (mutationInFlight.current.has(item.id)) return;
    mutationInFlight.current.add(item.id);
    setBusyItemIds((current) => new Set(current).add(item.id));
    try {
      const key = createIdempotencyKey();
      if (action === "pickup") await pickupItem(orderId, item.id, key);
      else await serveItem(orderId, item.id, key);
      await loadTable(true);
      setToast({
        message: action === "pickup" ? "Đã xác nhận lấy món từ bếp." : "Đã xác nhận mang món ra bàn.",
        type: "success",
      });
    } catch (actionError) {
      if (actionError instanceof ApiError && actionError.status === 409) await loadTable(true);
      setToast({ message: tableDetailError(actionError), type: "error" });
    } finally {
      mutationInFlight.current.delete(item.id);
      setBusyItemIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
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
      <main className="nova-content">
        {state === "loading" ? <StateCard kind="loading" title="Đang tải chi tiết bàn" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải chi tiết bàn" message={error} onRetry={() => void loadTable()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại chi tiết bàn" busy={refreshing} onClick={() => void loadTable(true)}>Thử lại</Button>
          </section>
        ) : null}

        {state === "ready" && table ? (
          <>
            <header className="nova-table-detail-header">
              <div className="nova-page-heading">
                <p className="nova-eyebrow">POS · Chi tiết bàn</p>
                <div className="nova-table-detail-title"><h1>Bàn {table.code}</h1><StatusBadge status={table.status} /></div>
                {table.current_session ? (
                  <p>{table.current_session.guest_count} khách · Đã mở {formatOpenDuration(table.current_session.opened_at)}</p>
                ) : null}
              </div>
              <div className="nova-order-header-actions">
                {table.current_session && table.status !== "BILLING" ? (
                  <Link className="nova-button nova-button--primary" to={`/tables/${encodeURIComponent(table.id)}/order`} aria-label={`Gọi món cho bàn ${table.code}`}>Gọi món</Link>
                ) : null}
                <Button variant="secondary" type="button" accessibleLabel="Làm mới chi tiết bàn" busy={refreshing} onClick={() => void loadTable(true)}>Làm mới</Button>
              </div>
            </header>

            {!table.current_session ? (
              <section className="nova-state-card">
                <h2>Bàn chưa có phiên</h2>
                <p>Hãy quay lại sơ đồ bàn để mở phiên phục vụ.</p>
                <Link className="nova-button nova-button--secondary" to="/tables">Về sơ đồ bàn</Link>
              </section>
            ) : (
              <>
                {table.status === "BILLING" ? <p className="nova-table-billing-note" role="status">Bàn đang chờ thanh toán</p> : null}
                {readyCount > 0 ? (
                  <section className="nova-ready-banner" role="status">
                    <strong>Có {readyCount} món đã xong, ra bếp lấy</strong>
                  </section>
                ) : null}

                {table.orders.length === 0 ? (
                  <StateCard kind="empty" title="Bàn chưa có đơn" message="Chọn Gọi món để tạo đơn đầu tiên." />
                ) : (
                  <div className="nova-table-orders">
                    {table.orders.map((order) => (
                      <section key={order.id} className="nova-table-order-card">
                        <header className="nova-table-order-header">
                          <div><p className="nova-topbar-label">Đơn {order.id.slice(-4).toUpperCase()}</p><strong>{formatVnd(order.subtotal)}</strong></div>
                          <StatusBadge status={order.status} />
                        </header>
                        {order.items.length === 0 ? <p className="nova-readonly-note">Đơn chưa có món.</p> : null}
                        {order.items.length > 0 ? (
                          <div className="nova-order-lines">
                            {order.items.map((item) => (
                              <div key={item.id} className="nova-table-item-wrap">
                                <OrderLineItem item={item} editable={false} onUpdate={noopItemUpdate} onRemove={noopItemRemove} />
                                {item.status === "READY" || item.status === "PICKED_UP" ? (
                                  <RoleGuard allow={["WAITER", "SUPERVISOR"]}>
                                    <Button
                                      variant="primary"
                                      type="button"
                                      accessibleLabel={`${item.status === "READY" ? "Lấy món" : "Đã mang ra"} ${item.menu_item_name}`}
                                      busy={busyItemIds.has(item.id)}
                                      disabled={refreshing}
                                      busyLabel="Đang cập nhật…"
                                      onClick={() => void updateItemStatus(order.id, item, item.status === "READY" ? "pickup" : "served")}
                                    >
                                      {item.status === "READY" ? "Lấy món" : "Đã mang ra"}
                                    </Button>
                                  </RoleGuard>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
