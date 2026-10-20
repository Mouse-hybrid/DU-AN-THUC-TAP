import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, getErrorMessage } from "../api/client";
import {
  getOrder,
  payOrder,
  requestBilling,
  type OrderDetail,
  type OrderItemDetail,
} from "../api/orders";
import { getTable, type TableDetailResponse } from "../api/tables";
import type { StaffRole } from "../auth/roles";
import { hasRole } from "../auth/roles";
import { getAuth, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { OrderLineItem } from "../components/OrderLineItem";
import { OrderSummary } from "../components/OrderSummary";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { createIdempotencyKey } from "../utils/idempotency";
import { selectCurrentOrder } from "../utils/orders";

const BILLING_ROLES = ["CASHIER", "WAITER", "SUPERVISOR"] as const satisfies readonly StaffRole[];
const PAY_ROLES = ["CASHIER", "SUPERVISOR"] as const satisfies readonly StaffRole[];

type Confirmation = "billing" | "pay" | null;

function summaryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Bạn không có quyền thực hiện thao tác này.";
    if (error.status === 404) return "Không tìm thấy bàn hoặc đơn cần thao tác.";
    if (error.status === 409) return "Trạng thái đơn vừa thay đổi. Dữ liệu đã được tải lại.";
    if (error.status === 422) return error.message || "Dữ liệu gửi lên chưa hợp lệ.";
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

function noopItemUpdate() {
  // Màn tóm tắt chỉ hiển thị món.
}

function noopItemRemove() {
  // Màn tóm tắt chỉ hiển thị món.
}

export function OrderSummaryPage() {
  const { id: tableId } = useParams<{ id: string }>();
  const role = getAuth()?.staff.role;
  const [table, setTable] = useState<TableDetailResponse | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [mutation, setMutation] = useState<Confirmation>(null);
  const [paid, setPaid] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const hasLoaded = useRef(false);
  const mutationInFlight = useRef(false);

  const loadData = useCallback(async (refresh = false, preferredOrderId?: string) => {
    if (!tableId) {
      setError("Thiếu mã định danh bàn.");
      setState("error");
      return;
    }
    if (refresh) setRefreshing(true);
    else if (!hasLoaded.current) setState("loading");
    setError("");
    try {
      const detail = await getTable(tableId);
      const selected = preferredOrderId
        ? detail.orders.find((candidate) => candidate.id === preferredOrderId) ?? null
        : selectCurrentOrder(detail.orders);
      const selectedId = preferredOrderId ?? selected?.id;
      const fullOrder = selectedId ? await getOrder(selectedId) : null;
      setTable(detail);
      setOrder(fullOrder);
      hasLoaded.current = true;
      setStale(false);
      setState("ready");
    } catch (loadError) {
      setError(summaryErrorMessage(loadError));
      if (hasLoaded.current) {
        setStale(true);
        setState("ready");
      } else {
        setState("error");
      }
    } finally {
      setRefreshing(false);
    }
  }, [tableId]);

  useEffect(() => {
    document.title = "Tóm tắt đơn · NOVA POS";
    void loadData();
  }, [loadData]);

  async function confirmMutation(kind: Exclude<Confirmation, null>) {
    if (!order || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setMutation(kind);
    const currentOrderId = order.id;
    try {
      const key = createIdempotencyKey();
      if (kind === "billing") {
        await requestBilling(currentOrderId, key);
        setToast({ message: "Đã gửi yêu cầu thanh toán.", type: "success" });
      } else {
        await payOrder(currentOrderId, key);
        setPaid(true);
        setToast({ message: "Đã thanh toán.", type: "success" });
      }
      setConfirmation(null);
      await loadData(true, currentOrderId);
    } catch (mutationError) {
      if (mutationError instanceof ApiError && mutationError.status === 409) {
        await loadData(true, currentOrderId);
      }
      setToast({ message: summaryErrorMessage(mutationError), type: "error" });
    } finally {
      mutationInFlight.current = false;
      setMutation(null);
    }
  }

  const activeItems = order?.items.filter((item) => item.status !== "VOIDED") ?? [];
  const canRequestBilling = Boolean(
    order && (order.status === "SENT" || order.status === "SERVED") && hasRole(role, BILLING_ROLES),
  );
  const canPay = Boolean(order?.status === "BILLING" && hasRole(role, PAY_ROLES));

  return (
    <AppShell
      topbar={
        <Link className="nova-back-link" to={tableId ? `/tables/${encodeURIComponent(tableId)}` : "/tables"}>
          <Icon name="chevron-left" />
          Quay lại chi tiết bàn
        </Link>
      }
    >
      <main className="nova-content">
        {state === "loading" ? <StateCard kind="loading" title="Đang tải tóm tắt đơn" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải tóm tắt đơn" message={error} onRetry={() => void loadData()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại tóm tắt đơn" busy={refreshing} onClick={() => void loadData(true)}>Thử lại</Button>
          </section>
        ) : null}

        {state === "ready" && table ? (
          <>
            <header className="nova-summary-header">
              <div className="nova-page-heading">
                <p className="nova-eyebrow">POS · Tóm tắt đơn</p>
                <h1>Bàn {table.code}</h1>
                <p>Kiểm tra món và tổng tiền trước khi thanh toán.</p>
              </div>
              <div className="nova-order-header-actions">
                {order ? <StatusBadge status={order.status} /> : null}
                <Button variant="secondary" type="button" accessibleLabel="Làm mới tóm tắt đơn" busy={refreshing} onClick={() => void loadData(true, order?.id)}>Làm mới</Button>
              </div>
            </header>

            {!order ? <StateCard kind="empty" title="Bàn chưa có đơn phù hợp" message="Không tìm thấy đơn đang mở hoặc đang chờ thanh toán." /> : (
              <section className="nova-summary-card" aria-labelledby="nova-summary-items-title">
                <div className="nova-section-heading">
                  <div><h2 id="nova-summary-items-title">Các món trong đơn</h2><p>{activeItems.length} dòng món đang được tính tiền</p></div>
                </div>
                {activeItems.length === 0 ? <p className="nova-readonly-note">Đơn chưa có món để thanh toán.</p> : (
                  <div className="nova-order-lines">
                    {activeItems.map((item: OrderItemDetail) => (
                      <OrderLineItem key={item.id} item={item} editable={false} onUpdate={noopItemUpdate} onRemove={noopItemRemove} />
                    ))}
                  </div>
                )}
                <OrderSummary order={order} />
                <div className="nova-summary-actions">
                  {canRequestBilling ? (
                    <Button variant="primary" type="button" accessibleLabel="Yêu cầu thanh toán đơn" disabled={mutation !== null} onClick={() => setConfirmation("billing")}>Yêu cầu thanh toán</Button>
                  ) : null}
                  {canPay ? (
                    <Button variant="primary" type="button" accessibleLabel="Xác nhận đơn đã thanh toán" disabled={mutation !== null} onClick={() => setConfirmation("pay")}>Xác nhận đã thanh toán</Button>
                  ) : null}
                  {paid || order.status === "PAID" ? <Link className="nova-button nova-button--secondary" to="/tables">Về sơ đồ bàn</Link> : null}
                </div>
                {order.status === "BILLING" && !canPay ? <p className="nova-readonly-note">Đơn đang chờ nhân viên thu ngân xác nhận thanh toán.</p> : null}
              </section>
            )}
          </>
        ) : null}
      </main>

      {confirmation === "billing" ? (
        <ConfirmDialog title="Yêu cầu thanh toán?" confirmLabel="Yêu cầu thanh toán" busy={mutation === "billing"} onCancel={() => setConfirmation(null)} onConfirm={() => void confirmMutation("billing")}>
          <p>Đơn sẽ được khóa để nhân viên thu ngân kiểm tra và thanh toán.</p>
        </ConfirmDialog>
      ) : null}
      {confirmation === "pay" ? (
        <ConfirmDialog title="Xác nhận đã thanh toán?" confirmLabel="Xác nhận đã thanh toán" busy={mutation === "pay"} onCancel={() => setConfirmation(null)} onConfirm={() => void confirmMutation("pay")}>
          <p>Hãy chỉ xác nhận sau khi đã nhận đủ tiền từ khách.</p>
        </ConfirmDialog>
      ) : null}
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
