import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { listCategories, listMenu, type MenuCategoryListResponse, type MenuListResponse } from "../api/menu";
import {
  getOrder,
  removeItem,
  sendToKitchen,
  updateItem,
  type OrderDetail,
  type OrderItemDetail,
} from "../api/orders";
import type { components } from "../api/schema";
import { getTable, type TableDetailResponse } from "../api/tables";
import type { StaffRole } from "../auth/roles";
import { hasRole } from "../auth/roles";
import { getAuth, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { MenuCategoryTabs } from "../components/MenuCategoryTabs";
import { MenuItemCard } from "../components/MenuItemCard";
import { OrderLineItem } from "../components/OrderLineItem";
import { OrderSummary } from "../components/OrderSummary";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { orderErrorMessage } from "../utils/errorMessages";
import { createIdempotencyKey } from "../utils/idempotency";
import { addMenuItemToOrder, resolveTableOrder } from "../utils/orderComposer";
import { isClosedOrderStatus } from "../utils/orders";

type MenuItem = components["schemas"]["MenuItemOut"];

const ORDER_WRITE_ROLES = ["CASHIER", "WAITER", "SUPERVISOR"] as const satisfies readonly StaffRole[];
function shortOrderCode(tableCode: string, orderId: string): string {
  return `${tableCode}-${orderId.replaceAll("-", "").slice(-4).toUpperCase()}`;
}

export function OrderPage() {
  const { id: tableId } = useParams<{ id: string }>();
  const role = getAuth()?.staff.role;
  const [table, setTable] = useState<TableDetailResponse | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [categories, setCategories] = useState<MenuCategoryListResponse>([]);
  const [menuItems, setMenuItems] = useState<MenuListResponse>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [pageState, setPageState] = useState<"loading" | "ready" | "error">("loading");
  const [menuState, setMenuState] = useState<"loading" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState("");
  const [menuError, setMenuError] = useState("");
  const [menuStale, setMenuStale] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mutation, setMutation] = useState<string | null>(null);
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const [closedOnlyMode, setClosedOnlyMode] = useState(false);
  const [multipleOpenOrders, setMultipleOpenOrders] = useState(false);
  const hasLoadedPage = useRef(false);
  const hasLoadedMenu = useRef(false);
  const mutationInFlight = useRef(new Set<string>());
  const sendInFlight = useRef(false);

  const canWrite = hasRole(role, ORDER_WRITE_ROLES);
  const readOnlyOrder = closedOnlyMode || Boolean(order && isClosedOrderStatus(order.status));
  const canAdd = canWrite && !readOnlyOrder;

  const loadOrder = useCallback(async (orderId: string) => {
    const detail = await getOrder(orderId);
    setOrder(detail);
    return detail;
  }, [setOrder]);

  const loadPage = useCallback(async (refresh = false) => {
    if (!tableId) {
      setPageError("Thiếu mã định danh bàn.");
      setPageState("error");
      return;
    }
    if (refresh) setRefreshing(true);
    else if (!hasLoadedPage.current) setPageState("loading");
    setPageError("");
    try {
      const detail = await getTable(tableId);
      const view = resolveTableOrder(detail);
      setTable(detail);
      setOrder(view.order);
      setClosedOnlyMode(view.closedOnly);
      setMultipleOpenOrders(view.multipleOpenOrders);
      hasLoadedPage.current = true;
      setStale(false);
      setPageState("ready");
    } catch (error) {
      setPageError(orderErrorMessage(error));
      if (hasLoadedPage.current) {
        setStale(true);
        setPageState("ready");
      } else {
        setPageState("error");
      }
    } finally {
      setRefreshing(false);
    }
  }, [tableId, setClosedOnlyMode, setMultipleOpenOrders, setPageError, setPageState, setRefreshing, setStale, setTable, setOrder]);

  const loadMenu = useCallback(async (categoryId: string | null) => {
    if (!hasLoadedMenu.current) setMenuState("loading");
    setMenuError("");
    try {
      const items = await listMenu({ available_only: false, category_id: categoryId });
      setMenuItems(items);
      hasLoadedMenu.current = true;
      setMenuStale(false);
      setMenuState("ready");
    } catch (error) {
      setMenuError(orderErrorMessage(error));
      if (hasLoadedMenu.current) {
        setMenuStale(true);
        setMenuState("ready");
      } else {
        setMenuState("error");
      }
    }
  }, [setMenuError, setMenuItems, setMenuStale, setMenuState]);

  useEffect(() => {
    document.title = "Gọi món · NOVA POS";
    void loadPage();
    void listCategories(true)
      .then(setCategories)
      .catch((error: unknown) => setToast({ message: orderErrorMessage(error), type: "error" }));
  }, [loadPage]);

  useEffect(() => {
    void loadMenu(selectedCategory);
  }, [loadMenu, selectedCategory]);

  const editableItems = useMemo(
    () => new Set(order?.items.filter((item) => item.status === "CREATED").map((item) => item.id) ?? []),
    [order],
  );

  async function reloadAfterConflict(orderId: string | undefined) {
    if (!orderId) return;
    try {
      await loadOrder(orderId);
    } catch {
      setStale(true);
    }
  }

  async function runItemMutation(
    actionKey: string,
    action: () => Promise<void>,
    conflictMessage?: string,
  ) {
    if (mutationInFlight.current.has(actionKey)) return;
    mutationInFlight.current.add(actionKey);
    setMutation(actionKey);
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadPage(true);
        setToast({ message: conflictMessage ?? orderErrorMessage(error), type: "error" });
      } else {
        setToast({ message: orderErrorMessage(error), type: "error" });
      }
    } finally {
      mutationInFlight.current.delete(actionKey);
      setMutation((current) => current === actionKey ? null : current);
    }
  }

  function addMenuItem(item: MenuItem) {
    const actionKey = `add:${item.id}`;
    void runItemMutation(actionKey, async () => {
      if (!table) throw new ApiError("Bàn chưa được tải xong.", 409);
      const updated = await addMenuItemToOrder({ table, order, item, onOrderCreated: setOrder });
      setOrder(updated);
      setToast({ message: `Đã thêm ${item.name}.`, type: "success" });
    }, "Không thể thêm món vì trạng thái bàn hoặc đơn đã thay đổi. Đã tải lại dữ liệu.");
  }

  function updateOrderLine(item: OrderItemDetail, quantity: number, note: string | null) {
    if (!order) return;
    const actionKey = `update:${item.id}`;
    void runItemMutation(actionKey, async () => {
      const key = createIdempotencyKey();
      await updateItem(order.id, item.id, { quantity, note }, key);
      await loadOrder(order.id);
      setToast({ message: `Đã cập nhật ${item.menu_item_name}.`, type: "success" });
    });
  }

  function removeOrderLine(item: OrderItemDetail) {
    if (!order) return;
    const actionKey = `remove:${item.id}`;
    void runItemMutation(actionKey, async () => {
      const key = createIdempotencyKey();
      await removeItem(order.id, item.id, key);
      await loadOrder(order.id);
      setToast({ message: `Đã xóa ${item.menu_item_name} khỏi đơn.`, type: "success" });
    });
  }

  async function submitToKitchen() {
    if (!order || sendInFlight.current) return;
    sendInFlight.current = true;
    setMutation("send");
    try {
      const key = createIdempotencyKey();
      await sendToKitchen(order.id, key);
      await loadOrder(order.id);
      setToast({ message: "Đã gửi món xuống bếp.", type: "success" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await reloadAfterConflict(order.id);
      setToast({ message: orderErrorMessage(error), type: "error" });
    } finally {
      sendInFlight.current = false;
      setMutation((current) => current === "send" ? null : current);
    }
  }

  const hasPendingItems = order?.items.some((item) => item.status === "CREATED") ?? false;

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
        {pageState === "loading" ? <StateCard kind="loading" title="Đang tải bàn và đơn" message="Vui lòng chờ trong giây lát." /> : null}
        {pageState === "error" ? <StateCard kind="error" title="Không thể mở màn gọi món" message={pageError} onRetry={() => void loadPage()} /> : null}
        {pageState === "ready" && table ? (
          <>
            <header className="nova-order-page-header">
              <div className="nova-page-heading">
                <p className="nova-eyebrow">POS · Gọi món</p>
                <h1>Bàn {table.code}</h1>
                <p>{table.current_session?.guest_count ?? 0} khách</p>
              </div>
              <div className="nova-order-header-actions">
                {order ? <StatusBadge status={order.status} /> : <StatusBadge status="NEW" label="Chưa tạo đơn" />}
                {canAdd ? (
                  <Link
                    className="nova-button nova-button--secondary"
                    to={`/tables/${encodeURIComponent(table.id)}/search`}
                    aria-label={`Tìm món nhanh cho bàn ${table.code}`}
                  >
                    Tìm món
                  </Link>
                ) : null}
                {order ? (
                  <Link
                    className="nova-button nova-button--secondary"
                    to={`/tables/${encodeURIComponent(table.id)}/summary`}
                    aria-label={`Tóm tắt đơn bàn ${table.code}`}
                  >
                    Tóm tắt đơn
                  </Link>
                ) : null}
                <Button
                  variant="secondary"
                  type="button"
                  accessibleLabel="Tải lại bàn và đơn"
                  busy={refreshing}
                  onClick={() => void loadPage(true)}
                >
                  Làm mới
                </Button>
              </div>
            </header>

            {stale ? (
              <section className="nova-stale-notice" role="alert">
                <div><strong>Dữ liệu có thể đã cũ</strong><p>{pageError || "Không thể tải dữ liệu mới nhất."}</p></div>
                <Button variant="secondary" type="button" accessibleLabel="Thử tải lại bàn và đơn" onClick={() => void loadPage(true)}>Thử lại</Button>
              </section>
            ) : null}

            <div className="nova-order-layout">
              <section className="nova-menu-panel" aria-labelledby="nova-menu-title">
                <div className="nova-section-heading">
                  <div><h2 id="nova-menu-title">Thực đơn</h2><p>Chọn món để thêm vào đơn.</p></div>
                </div>
                <MenuCategoryTabs
                  categories={categories}
                  selectedId={selectedCategory}
                  disabled={menuState === "loading"}
                  onChange={setSelectedCategory}
                />
                {menuState === "ready" && menuStale ? (
                  <section className="nova-stale-notice" role="alert">
                    <div><strong>Thực đơn có thể đã cũ</strong><p>{menuError}</p></div>
                    <Button variant="secondary" type="button" accessibleLabel="Thử tải lại thực đơn" onClick={() => void loadMenu(selectedCategory)}>Thử lại</Button>
                  </section>
                ) : null}
                {menuState === "loading" ? <StateCard kind="loading" title="Đang tải thực đơn" message="Vui lòng chờ trong giây lát." /> : null}
                {menuState === "error" ? <StateCard kind="error" title="Không thể tải thực đơn" message={menuError} onRetry={() => void loadMenu(selectedCategory)} /> : null}
                {menuState === "ready" && menuItems.length === 0 ? <StateCard kind="empty" title="Chưa có món trong nhóm này" message="Hãy chọn một nhóm món khác." /> : null}
                {menuState === "ready" && menuItems.length > 0 ? (
                  <div className="nova-menu-grid">
                    {menuItems.map((item) => (
                      <MenuItemCard
                        key={item.id}
                        item={item}
                        busy={mutation === `add:${item.id}`}
                        disabled={!canAdd || mutation !== null}
                        showAddAction={canAdd}
                        onAdd={addMenuItem}
                      />
                    ))}
                  </div>
                ) : null}
              </section>

              <aside className="nova-order-panel" aria-labelledby="nova-order-title">
                <div className="nova-section-heading">
                  <div>
                    <h2 id="nova-order-title">Đơn gọi món</h2>
                    <p>{order ? `Mã tạm ${shortOrderCode(table.code, order.id)}` : "Đơn chưa được tạo"}</p>
                  </div>
                </div>
                {!order || order.items.length === 0 ? (
                  <div className="nova-order-empty"><p>Chưa có món trong đơn.</p></div>
                ) : (
                  <div className="nova-order-lines">
                    {order.items.map((item) => (
                      <OrderLineItem
                        key={item.id}
                        item={item}
                        editable={canWrite && !readOnlyOrder && editableItems.has(item.id)}
                        updating={mutation === `update:${item.id}`}
                        removing={mutation === `remove:${item.id}`}
                        onUpdate={updateOrderLine}
                        onRemove={removeOrderLine}
                      />
                    ))}
                  </div>
                )}
                <OrderSummary order={order} />
                {multipleOpenOrders ? <p className="nova-order-warning" role="status">Bàn có nhiều đơn đang mở</p> : null}
                {readOnlyOrder ? <p className="nova-readonly-note">Bàn đang chờ thanh toán</p> : null}
                {canWrite && !readOnlyOrder && order && hasPendingItems ? (
                  <Button
                    className="nova-button--full"
                    variant="primary"
                    type="button"
                    accessibleLabel="Gửi các món mới xuống bếp"
                    busy={mutation === "send"}
                    busyLabel="Đang gửi bếp…"
                    disabled={mutation !== null && mutation !== "send"}
                    onClick={() => void submitToKitchen()}
                  >
                    Gửi bếp
                  </Button>
                ) : null}
                {!canWrite && !readOnlyOrder ? <p className="nova-readonly-note">Bạn chỉ có quyền xem đơn này.</p> : null}
              </aside>
            </div>
          </>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
