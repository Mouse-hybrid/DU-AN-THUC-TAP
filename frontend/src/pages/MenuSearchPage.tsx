import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { listCategories, listMenu, type MenuCategoryListResponse, type MenuListResponse } from "../api/menu";
import type { OrderDetail } from "../api/orders";
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
import { OrderSummary } from "../components/OrderSummary";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { orderErrorMessage } from "../utils/errorMessages";
import { addMenuItemToOrder, resolveTableOrder } from "../utils/orderComposer";
import { useDebouncedValue } from "../utils/useDebouncedValue";

type MenuItem = components["schemas"]["MenuItemOut"];

const ORDER_WRITE_ROLES = ["CASHIER", "WAITER", "SUPERVISOR"] as const satisfies readonly StaffRole[];
const SEARCH_DEBOUNCE_MS = 300;

export function MenuSearchPage() {
  const { id: tableId } = useParams<{ id: string }>();
  const role = getAuth()?.staff.role;
  const canWrite = hasRole(role, ORDER_WRITE_ROLES);

  const [table, setTable] = useState<TableDetailResponse | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [pageState, setPageState] = useState<"loading" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState("");
  const [pageStale, setPageStale] = useState(false);
  const [categories, setCategories] = useState<MenuCategoryListResponse>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [menuItems, setMenuItems] = useState<MenuListResponse>([]);
  const [menuState, setMenuState] = useState<"loading" | "ready" | "error">("loading");
  const [menuError, setMenuError] = useState("");
  const [menuStale, setMenuStale] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const hasLoadedPage = useRef(false);
  const hasLoadedMenu = useRef(false);
  const menuRequestId = useRef(0);
  const addInFlight = useRef(false);

  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const canAdd = canWrite && !readOnly;

  const loadTable = useCallback(async () => {
    if (!tableId) {
      setPageError("Thiếu mã định danh bàn.");
      setPageState("error");
      return;
    }
    if (!hasLoadedPage.current) setPageState("loading");
    setPageError("");
    try {
      const detail = await getTable(tableId);
      const view = resolveTableOrder(detail);
      setTable(detail);
      setOrder(view.order);
      setReadOnly(view.readOnly);
      hasLoadedPage.current = true;
      setPageStale(false);
      setPageState("ready");
    } catch (error) {
      setPageError(orderErrorMessage(error));
      if (hasLoadedPage.current) {
        setPageStale(true);
        setPageState("ready");
      } else {
        setPageState("error");
      }
    }
  }, [tableId]);

  const loadMenu = useCallback(async (keyword: string, categoryId: string | null) => {
    // Chỉ kết quả của request mới nhất được áp dụng; kết quả của từ khóa cũ bị bỏ.
    menuRequestId.current += 1;
    const requestId = menuRequestId.current;
    if (!hasLoadedMenu.current) setMenuState("loading");
    setSearching(true);
    setMenuError("");
    try {
      const items = await listMenu({ available_only: false, category_id: categoryId, q: keyword });
      if (requestId !== menuRequestId.current) return;
      setMenuItems(items);
      hasLoadedMenu.current = true;
      setMenuStale(false);
      setMenuState("ready");
    } catch (error) {
      if (requestId !== menuRequestId.current) return;
      setMenuError(orderErrorMessage(error));
      if (hasLoadedMenu.current) {
        setMenuStale(true);
        setMenuState("ready");
      } else {
        setMenuState("error");
      }
    } finally {
      if (requestId === menuRequestId.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Tìm món nhanh · NOVA POS";
    void loadTable();
    void listCategories(true)
      .then(setCategories)
      .catch((error: unknown) => setToast({ message: orderErrorMessage(error), type: "error" }));
  }, [loadTable]);

  useEffect(() => {
    void loadMenu(debouncedQuery, selectedCategory);
  }, [loadMenu, debouncedQuery, selectedCategory]);

  async function addMenuItem(item: MenuItem) {
    if (!table || addInFlight.current) return;
    addInFlight.current = true;
    setBusyItemId(item.id);
    try {
      const updated = await addMenuItemToOrder({ table, order, item, onOrderCreated: setOrder });
      setOrder(updated);
      setToast({ message: `Đã thêm ${item.name} vào đơn.`, type: "success" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await loadTable();
      setToast({ message: orderErrorMessage(error), type: "error" });
    } finally {
      addInFlight.current = false;
      setBusyItemId(null);
    }
  }

  const trimmedQuery = query.trim();
  const orderPath = table ? `/tables/${encodeURIComponent(table.id)}/order` : "/tables";
  const readOnlyNote = order?.status === "BILLING" || (readOnly && !order)
    ? "Bàn đang chờ thanh toán. Chỉ xem, không thể thêm món."
    : "Đơn đã đóng. Chỉ xem, không thể thêm món.";

  return (
    <AppShell
      topbar={
        <Link className="nova-back-link" to={orderPath}>
          <Icon name="chevron-left" />
          Quay lại gọi món
        </Link>
      }
    >
      <main className="nova-content">
        {pageState === "loading" ? <StateCard kind="loading" title="Đang tải bàn và đơn" message="Vui lòng chờ trong giây lát." /> : null}
        {pageState === "error" ? <StateCard kind="error" title="Không thể mở màn tìm món" message={pageError} onRetry={() => void loadTable()} /> : null}
        {pageState === "ready" && table ? (
          <>
            <header className="nova-order-page-header">
              <div className="nova-page-heading">
                <p className="nova-eyebrow">POS · Gọi món</p>
                <h1>Tìm món nhanh</h1>
                <p>Bàn {table.code} · {table.current_session?.guest_count ?? 0} khách</p>
              </div>
              <div className="nova-order-header-actions">
                {order ? <StatusBadge status={order.status} /> : <StatusBadge status="NEW" label="Chưa tạo đơn" />}
                <Link className="nova-button nova-button--secondary" to={orderPath} aria-label={`Mở màn gọi món bàn ${table.code}`}>
                  Xem đơn
                </Link>
              </div>
            </header>

            {pageStale ? (
              <section className="nova-stale-notice" role="alert">
                <div><strong>Dữ liệu có thể đã cũ</strong><p>{pageError || "Không thể tải dữ liệu mới nhất."}</p></div>
                <Button variant="secondary" type="button" accessibleLabel="Thử tải lại bàn và đơn" onClick={() => void loadTable()}>Thử lại</Button>
              </section>
            ) : null}

            <div className="nova-order-layout">
              <section className="nova-menu-panel" aria-labelledby="nova-search-title">
                <div className="nova-section-heading">
                  <div><h2 id="nova-search-title">Kết quả tìm kiếm</h2><p>Tìm theo tên món, hoặc lọc theo nhóm món.</p></div>
                </div>
                <div className="nova-field nova-search-field">
                  <label htmlFor="nova-menu-search">Tìm theo tên món</label>
                  <input
                    id="nova-menu-search"
                    type="search"
                    autoComplete="off"
                    placeholder="Ví dụ: phở bò"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <MenuCategoryTabs categories={categories} selectedId={selectedCategory} onChange={setSelectedCategory} />
                {readOnly ? <p className="nova-readonly-note">{readOnlyNote}</p> : null}
                {!canWrite && !readOnly ? <p className="nova-readonly-note">Bạn chỉ có quyền xem thực đơn.</p> : null}
                {menuState === "ready" && menuStale ? (
                  <section className="nova-stale-notice" role="alert">
                    <div><strong>Dữ liệu có thể đã cũ</strong><p>{menuError}</p></div>
                    <Button variant="secondary" type="button" accessibleLabel="Thử tải lại kết quả tìm món" onClick={() => void loadMenu(debouncedQuery, selectedCategory)}>Thử lại</Button>
                  </section>
                ) : null}
                {menuState === "loading" ? <StateCard kind="loading" title="Đang tải thực đơn" message="Vui lòng chờ trong giây lát." /> : null}
                {menuState === "error" ? <StateCard kind="error" title="Không thể tải thực đơn" message={menuError} onRetry={() => void loadMenu(debouncedQuery, selectedCategory)} /> : null}
                {menuState === "ready" ? (
                  <p className="nova-search-meta" role="status" aria-live="polite">
                    {searching ? "Đang tìm…" : `${menuItems.length} món`}
                  </p>
                ) : null}
                {menuState === "ready" && menuItems.length === 0 && !searching ? (
                  <StateCard
                    kind="empty"
                    title="Không tìm thấy món"
                    message={trimmedQuery ? `Không có món nào khớp "${trimmedQuery}". Hãy thử từ khóa hoặc nhóm món khác.` : "Chưa có món trong nhóm này."}
                  />
                ) : null}
                {menuState === "ready" && menuItems.length > 0 ? (
                  <div className="nova-menu-grid">
                    {menuItems.map((item) => (
                      <MenuItemCard
                        key={item.id}
                        item={item}
                        addLabel="Thêm vào đơn"
                        busy={busyItemId === item.id}
                        disabled={!canAdd || busyItemId !== null}
                        showAddAction={canAdd}
                        onAdd={(selected) => void addMenuItem(selected)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>

              <aside className="nova-order-panel" aria-labelledby="nova-search-order-title">
                <div className="nova-section-heading">
                  <div>
                    <h2 id="nova-search-order-title">Đơn của bàn {table.code}</h2>
                    <p>{order ? `${order.items.filter((line) => line.status !== "VOIDED").length} dòng món` : "Đơn chưa được tạo"}</p>
                  </div>
                </div>
                <OrderSummary order={order} />
                <Link className="nova-button nova-button--primary nova-button--full" to={orderPath} aria-label={`Mở màn gọi món bàn ${table.code} để chỉnh số lượng và gửi bếp`}>
                  Mở màn gọi món
                </Link>
              </aside>
            </div>
          </>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
