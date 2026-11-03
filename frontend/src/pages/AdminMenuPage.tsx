import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  createCategory,
  listCategories,
  listMenu,
  updateCategory,
  type MenuCategory,
  type MenuCategoryUpdate,
  type MenuItem,
} from "../api/menu";
import { consumeFlash, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { StateCard } from "../components/StateCard";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { adminErrorMessage } from "../utils/errorMessages";
import { formatVnd } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";

const MAX_NAME_LENGTH = 100;
const MAX_SORT_ORDER = 10_000;
const CATEGORY_ERRORS = {
  notFound: "Không tìm thấy nhóm món. Danh sách đã được tải lại.",
  conflict: "Tên nhóm món đã tồn tại hoặc dữ liệu đã thay đổi. Danh sách đã được tải lại.",
};

function parseSortOrder(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed <= MAX_SORT_ORDER ? parsed : null;
}

function validateName(value: string): string {
  const name = value.trim();
  if (!name) return "Vui lòng nhập tên nhóm món.";
  if (name.length > MAX_NAME_LENGTH) return `Tên nhóm món tối đa ${MAX_NAME_LENGTH} ký tự.`;
  return "";
}

interface CategoryRowProps {
  category: MenuCategory;
  busy: boolean;
  disabled: boolean;
  onSave: (category: MenuCategory, patch: MenuCategoryUpdate) => void;
  onToggle: (category: MenuCategory) => void;
}

function CategoryRow({ category, busy, disabled, onSave, onToggle }: CategoryRowProps) {
  const [name, setName] = useState(category.name);
  const [sortOrder, setSortOrder] = useState(String(category.sort_order));
  const [touched, setTouched] = useState(false);

  const nameError = validateName(name);
  const parsedOrder = parseSortOrder(sortOrder);
  const orderError = parsedOrder === null ? `Thứ tự là số nguyên từ 0 đến ${MAX_SORT_ORDER.toLocaleString("vi-VN")}.` : "";
  const changed = name.trim() !== category.name || parsedOrder !== category.sort_order;

  function save() {
    setTouched(true);
    if (nameError || orderError || !changed || parsedOrder === null) return;
    const patch: MenuCategoryUpdate = {};
    if (name.trim() !== category.name) patch.name = name.trim();
    if (parsedOrder !== category.sort_order) patch.sort_order = parsedOrder;
    onSave(category, patch);
  }

  return (
    <li className="nova-admin-row">
      <div className="nova-field">
        <label htmlFor={`category-name-${category.id}`}>Tên nhóm</label>
        <input
          id={`category-name-${category.id}`}
          value={name}
          maxLength={MAX_NAME_LENGTH + 20}
          aria-invalid={touched && Boolean(nameError)}
          disabled={disabled || busy}
          onChange={(event) => setName(event.target.value)}
        />
        {touched && nameError ? <p className="nova-field-error">{nameError}</p> : null}
      </div>
      <div className="nova-field">
        <label htmlFor={`category-order-${category.id}`}>Thứ tự</label>
        <input
          id={`category-order-${category.id}`}
          inputMode="numeric"
          value={sortOrder}
          aria-invalid={touched && Boolean(orderError)}
          disabled={disabled || busy}
          onChange={(event) => setSortOrder(event.target.value)}
        />
        {touched && orderError ? <p className="nova-field-error">{orderError}</p> : null}
      </div>
      <StatusBadge status={category.is_active ? "READY" : "UNAVAILABLE"} label={category.is_active ? "Đang bật" : "Đã tắt"} />
      <div className="nova-admin-actions">
        <Button
          variant="secondary"
          type="button"
          accessibleLabel={`Lưu nhóm món ${category.name}`}
          busy={busy}
          busyLabel="Đang lưu…"
          disabled={disabled || !changed}
          onClick={save}
        >
          Lưu
        </Button>
        <Button
          variant={category.is_active ? "danger" : "primary"}
          type="button"
          accessibleLabel={`${category.is_active ? "Tắt" : "Bật"} nhóm món ${category.name}`}
          disabled={disabled || busy}
          onClick={() => onToggle(category)}
        >
          {category.is_active ? "Tắt nhóm" : "Bật nhóm"}
        </Button>
      </div>
    </li>
  );
}

export function AdminMenuPage() {
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [newName, setNewName] = useState("");
  const [newOrder, setNewOrder] = useState("");
  const [createSubmitted, setCreateSubmitted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(() => consumeFlash());
  const hasLoaded = useRef(false);
  const loadInFlight = useRef(false);
  const mutationInFlight = useRef(new Set<string>());

  const load = useCallback(async (refresh = false) => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    if (refresh) setRefreshing(true);
    else if (!hasLoaded.current) setState("loading");
    setError("");
    try {
      // active_only=false: trang quản trị phải thấy cả nhóm đã tắt để bật lại được.
      const [nextCategories, nextItems] = await Promise.all([listCategories(false), listMenu({ available_only: false })]);
      setCategories(nextCategories);
      setItems(nextItems);
      hasLoaded.current = true;
      setStale(false);
      setState("ready");
    } catch (loadError) {
      setError(adminErrorMessage(loadError, CATEGORY_ERRORS));
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
  }, []);

  useEffect(() => {
    document.title = "Quản lý nhóm món · NOVA POS";
    void load();
  }, [load]);

  const categoryNames = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories]);
  const nextSortOrder = useMemo(
    () => Math.min(MAX_SORT_ORDER, categories.reduce((max, category) => Math.max(max, category.sort_order), -1) + 1),
    [categories],
  );

  const newNameError = validateName(newName);
  const newOrderValue = newOrder.trim() === "" ? nextSortOrder : parseSortOrder(newOrder);
  const newOrderError = newOrderValue === null ? `Thứ tự là số nguyên từ 0 đến ${MAX_SORT_ORDER.toLocaleString("vi-VN")}.` : "";

  async function runMutation(actionKey: string, action: () => Promise<string>) {
    if (mutationInFlight.current.has(actionKey)) return;
    mutationInFlight.current.add(actionKey);
    setBusyIds((current) => new Set(current).add(actionKey));
    try {
      if (!navigator.onLine) throw new ApiError("Bạn đang ngoại tuyến. Thao tác chưa được gửi.", 0);
      const message = await action();
      await load(true);
      setToast({ message, type: "success" });
    } catch (mutationError) {
      if (mutationError instanceof ApiError && (mutationError.status === 409 || mutationError.status === 404)) {
        await load(true);
      }
      setToast({ message: adminErrorMessage(mutationError, CATEGORY_ERRORS), type: "error" });
    } finally {
      mutationInFlight.current.delete(actionKey);
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(actionKey);
        return next;
      });
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateSubmitted(true);
    if (newNameError || newOrderError || newOrderValue === null || creating) return;
    setCreating(true);
    try {
      await runMutation("create", async () => {
        await createCategory({ name: newName.trim(), sort_order: newOrderValue, is_active: true }, createIdempotencyKey());
        setNewName("");
        setNewOrder("");
        setCreateSubmitted(false);
        return `Đã thêm nhóm ${newName.trim()}.`;
      });
    } finally {
      setCreating(false);
    }
  }

  function saveCategory(category: MenuCategory, patch: MenuCategoryUpdate) {
    void runMutation(`save:${category.id}`, async () => {
      await updateCategory(category.id, patch, createIdempotencyKey());
      return `Đã lưu nhóm ${patch.name ?? category.name}.`;
    });
  }

  function toggleCategory(category: MenuCategory) {
    void runMutation(`save:${category.id}`, async () => {
      await updateCategory(category.id, { is_active: !category.is_active }, createIdempotencyKey());
      return `Đã ${category.is_active ? "tắt" : "bật"} nhóm ${category.name}.`;
    });
  }

  const anyBusy = busyIds.size > 0;

  return (
    <AppShell
      topbar={
        <div>
          <p className="nova-topbar-label">NOVA Admin</p>
          <strong>Quản lý thực đơn</strong>
        </div>
      }
    >
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Quản trị · Thực đơn</p>
            <h1>Quản lý nhóm món</h1>
            <p>Thêm nhóm, đổi tên, đổi thứ tự hoặc bật/tắt nhóm món.</p>
          </div>
          <div className="nova-toolbar-actions">
            <Button
              variant="secondary"
              type="button"
              accessibleLabel="Tải lại danh sách nhóm món"
              busy={refreshing}
              busyLabel="Đang tải…"
              onClick={() => void load(true)}
            >
              Làm mới
            </Button>
          </div>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải nhóm món" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải nhóm món" message={error} onRetry={() => void load()} /> : null}
        {state === "ready" && stale ? (
          <section className="nova-stale-notice" role="alert">
            <div><strong>Dữ liệu có thể đã cũ</strong><p>{error}</p></div>
            <Button variant="secondary" type="button" accessibleLabel="Thử tải lại danh sách nhóm món" busy={refreshing} onClick={() => void load(true)}>Thử lại</Button>
          </section>
        ) : null}

        {state === "ready" ? (
          <>
            <section className="nova-admin-section" aria-labelledby="nova-add-category-title">
              <h2 id="nova-add-category-title">Thêm nhóm món</h2>
              <form className="nova-admin-add-form" noValidate onSubmit={(event) => void handleCreate(event)}>
                <div className="nova-field">
                  <label htmlFor="nova-new-category-name">Tên nhóm</label>
                  <input
                    id="nova-new-category-name"
                    value={newName}
                    placeholder="Ví dụ: Món chính"
                    aria-invalid={createSubmitted && Boolean(newNameError)}
                    disabled={creating}
                    onChange={(event) => setNewName(event.target.value)}
                  />
                  {createSubmitted && newNameError ? <p className="nova-field-error">{newNameError}</p> : null}
                </div>
                <div className="nova-field">
                  <label htmlFor="nova-new-category-order">Thứ tự</label>
                  <input
                    id="nova-new-category-order"
                    inputMode="numeric"
                    value={newOrder}
                    placeholder={String(nextSortOrder)}
                    aria-invalid={createSubmitted && Boolean(newOrderError)}
                    disabled={creating}
                    onChange={(event) => setNewOrder(event.target.value)}
                  />
                  {createSubmitted && newOrderError ? <p className="nova-field-error">{newOrderError}</p> : null}
                </div>
                <Button variant="primary" type="submit" accessibleLabel="Thêm nhóm món" busy={creating} busyLabel="Đang thêm…" disabled={anyBusy && !creating}>
                  Thêm nhóm
                </Button>
              </form>
            </section>

            <section className="nova-admin-section" aria-labelledby="nova-category-list-title">
              <h2 id="nova-category-list-title">Danh sách nhóm món</h2>
              {categories.length === 0 ? (
                <StateCard kind="empty" title="Chưa có nhóm món" message="Hãy thêm nhóm món đầu tiên ở phía trên." />
              ) : (
                <ul className="nova-admin-list">
                  {categories.map((category) => (
                    <CategoryRow
                      key={`${category.id}:${category.name}:${category.sort_order}:${String(category.is_active)}`}
                      category={category}
                      busy={busyIds.has(`save:${category.id}`)}
                      disabled={creating}
                      onSave={saveCategory}
                      onToggle={toggleCategory}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="nova-admin-section" aria-labelledby="nova-item-list-title">
              <div className="nova-section-heading">
                <div><h2 id="nova-item-list-title">Món ăn</h2><p>Chọn món để sửa giá, nhóm, trạm bếp hoặc bật/tắt bán.</p></div>
                <Link className="nova-button nova-button--primary" to="/admin/menu/new" aria-label="Thêm món mới">Thêm món</Link>
              </div>
              {items.length === 0 ? (
                <StateCard kind="empty" title="Chưa có món" message="Hãy thêm món đầu tiên." />
              ) : (
                <ul className="nova-admin-list">
                  {items.map((item) => (
                    <li key={item.id} className="nova-admin-item-row">
                      <div>
                        <strong>{item.name}</strong>
                        <p>{item.category_id ? categoryNames.get(item.category_id) ?? "Nhóm không xác định" : "Chưa gán nhóm"}</p>
                      </div>
                      <strong>{formatVnd(item.price)}</strong>
                      <StatusBadge status={item.is_available ? "READY" : "UNAVAILABLE"} label={item.is_available ? "Đang bán" : "Hết món"} />
                      <Link
                        className="nova-button nova-button--secondary"
                        to={`/admin/menu/${encodeURIComponent(item.id)}/edit`}
                        aria-label={`Sửa món ${item.name}`}
                      >
                        Sửa
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
