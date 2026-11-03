import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listStations, type KitchenStationResponse } from "../api/kitchen";
import {
  createMenuItem,
  listCategories,
  listMenu,
  updateMenuItem,
  type MenuCategory,
  type MenuItem,
  type MenuItemUpdate,
} from "../api/menu";
import { setFlash } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { StateCard } from "../components/StateCard";
import { adminErrorMessage } from "../utils/errorMessages";
import { formatVnd } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";

const MAX_NAME_LENGTH = 255;
const ITEM_ERRORS = {
  notFound: "Không tìm thấy món, nhóm món hoặc trạm bếp. Có thể dữ liệu đã thay đổi, hãy tải lại trang.",
  conflict: "Dữ liệu món đã thay đổi. Hãy tải lại trang rồi thử lại.",
};
const UNSUPPORTED_NOTE = "Ảnh, mô tả, nhãn món và hiển thị QR chưa được API hỗ trợ.";

/** API: giá > 0, tối đa 12 chữ số trong đó 2 số lẻ. Chấp nhận dấu "," hoặc "." làm dấu thập phân. */
function parsePrice(value: string): { normalized: string | null; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { normalized: null, error: "Vui lòng nhập giá bán." };
  if (!/^\d{1,10}([.,]\d{1,2})?$/.test(trimmed)) {
    return { normalized: null, error: "Giá bán phải là số, tối đa 2 chữ số thập phân." };
  }
  const normalized = trimmed.replace(",", ".");
  if (Number(normalized) <= 0) return { normalized: null, error: "Giá bán phải lớn hơn 0." };
  return { normalized, error: "" };
}

function priceToInput(price: string): string {
  const amount = Number(price);
  return Number.isFinite(amount) ? String(amount) : price;
}

function samePrice(left: string, right: string): boolean {
  return Number(left) === Number(right);
}

export function AdminMenuItemPage() {
  const { id: itemId } = useParams<{ id: string }>();
  const isEdit = Boolean(itemId);
  const navigate = useNavigate();
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [stations, setStations] = useState<KitchenStationResponse>([]);
  const [original, setOriginal] = useState<MenuItem | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [stationId, setStationId] = useState("");
  const [isAvailable, setIsAvailable] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState("");
  const submitInFlight = useRef(false);

  const load = useCallback(async () => {
    setState("loading");
    setLoadError("");
    try {
      const [nextCategories, nextStations, nextItems] = await Promise.all([
        listCategories(false),
        listStations(),
        itemId ? listMenu({ available_only: false }) : Promise.resolve(null),
      ]);
      setCategories(nextCategories);
      setStations(nextStations);
      if (itemId) {
        const found = nextItems?.find((item) => item.id === itemId);
        if (!found) {
          setState("missing");
          return;
        }
        setOriginal(found);
        setName(found.name);
        setPrice(priceToInput(found.price));
        setCategoryId(found.category_id ?? "");
        setStationId(found.station_id ?? "");
        setIsAvailable(found.is_available);
      }
      setState("ready");
    } catch (error) {
      setLoadError(adminErrorMessage(error, ITEM_ERRORS));
      setState("error");
    }
  }, [itemId]);

  useEffect(() => {
    document.title = `${isEdit ? "Sửa món" : "Thêm món"} · NOVA POS`;
    void load();
  }, [isEdit, load]);

  const categoryOptions = useMemo(
    () => categories.filter((category) => category.is_active || category.id === original?.category_id),
    [categories, original],
  );
  const stationOptions = useMemo(
    () => stations.filter((station) => station.is_active || station.id === original?.station_id),
    [stations, original],
  );

  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? "Vui lòng nhập tên món."
    : trimmedName.length > MAX_NAME_LENGTH ? `Tên món tối đa ${MAX_NAME_LENGTH} ký tự.` : "";
  const parsedPrice = parsePrice(price);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setAlert("");
    if (nameError || parsedPrice.error || parsedPrice.normalized === null || submitInFlight.current) return;
    if (!navigator.onLine) {
      setAlert("Bạn đang ngoại tuyến. Thao tác chưa được gửi.");
      return;
    }

    // Chỉ gửi các field API hỗ trợ: name, price, category_id, station_id, is_available.
    const nextCategory = categoryId || null;
    const nextStation = stationId || null;
    let patch: MenuItemUpdate | null = null;
    if (original) {
      patch = {};
      if (trimmedName !== original.name) patch.name = trimmedName;
      if (!samePrice(parsedPrice.normalized, original.price)) patch.price = parsedPrice.normalized;
      if (nextCategory !== original.category_id) patch.category_id = nextCategory;
      if (nextStation !== original.station_id) patch.station_id = nextStation;
      if (isAvailable !== original.is_available) patch.is_available = isAvailable;
      if (Object.keys(patch).length === 0) {
        setAlert("Chưa có thay đổi nào để lưu.");
        return;
      }
    }

    submitInFlight.current = true;
    setBusy(true);
    try {
      const key = createIdempotencyKey();
      if (original && patch) {
        await updateMenuItem(original.id, patch, key);
        setFlash(`Đã lưu món ${trimmedName}.`, "success");
      } else {
        await createMenuItem(
          { name: trimmedName, price: parsedPrice.normalized, category_id: nextCategory, station_id: nextStation, is_available: isAvailable },
          key,
        );
        setFlash(`Đã thêm món ${trimmedName}.`, "success");
      }
      navigate("/admin/menu/categories", { replace: true });
    } catch (error) {
      // Giữ nguyên dữ liệu đang nhập để người dùng sửa và gửi lại.
      setAlert(adminErrorMessage(error, ITEM_ERRORS));
    } finally {
      submitInFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <AppShell
      topbar={
        <Link className="nova-back-link" to="/admin/menu/categories">
          <Icon name="chevron-left" />
          Quay lại danh sách
        </Link>
      }
    >
      <main className="nova-content">
        <div className="nova-page-heading">
          <p className="nova-eyebrow">Quản trị · Thực đơn</p>
          <h1>{isEdit ? "Sửa món" : "Thêm món"}</h1>
          <p>{UNSUPPORTED_NOTE}</p>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải dữ liệu" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải dữ liệu" message={loadError} onRetry={() => void load()} /> : null}
        {state === "missing" ? <StateCard kind="empty" title="Không tìm thấy món" message="Món này không còn trong thực đơn. Hãy quay lại danh sách và chọn lại." /> : null}

        {state === "ready" ? (
          <form className="nova-admin-section nova-admin-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
            {alert ? <div className="nova-alert" role="alert">{alert}</div> : null}

            <div className="nova-field">
              <label htmlFor="nova-item-name">Tên món</label>
              <input
                id="nova-item-name"
                value={name}
                autoComplete="off"
                aria-invalid={submitted && Boolean(nameError)}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
              {submitted && nameError ? <p className="nova-field-error">{nameError}</p> : null}
            </div>

            <div className="nova-field">
              <label htmlFor="nova-item-price">Giá bán (₫)</label>
              <input
                id="nova-item-price"
                inputMode="decimal"
                value={price}
                autoComplete="off"
                aria-invalid={submitted && Boolean(parsedPrice.error)}
                disabled={busy}
                onChange={(event) => setPrice(event.target.value)}
              />
              {submitted && parsedPrice.error ? <p className="nova-field-error">{parsedPrice.error}</p> : null}
              {parsedPrice.normalized ? <p className="nova-field-hint">Hiển thị: {formatVnd(parsedPrice.normalized)}</p> : null}
            </div>

            <div className="nova-field">
              <label htmlFor="nova-item-category">Danh mục</label>
              <select id="nova-item-category" value={categoryId} disabled={busy} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">Chưa gán nhóm</option>
                {categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}{category.is_active ? "" : " (đã tắt)"}</option>
                ))}
              </select>
            </div>

            <div className="nova-field">
              <label htmlFor="nova-item-station">Trạm bếp</label>
              <select id="nova-item-station" value={stationId} disabled={busy} onChange={(event) => setStationId(event.target.value)}>
                <option value="">Chưa gán trạm</option>
                {stationOptions.map((station) => (
                  <option key={station.id} value={station.id}>{station.name}{station.is_active ? "" : " (ngừng dùng)"}</option>
                ))}
              </select>
            </div>

            <label className="nova-checkbox-field" htmlFor="nova-item-available">
              <input
                id="nova-item-available"
                type="checkbox"
                checked={isAvailable}
                disabled={busy}
                onChange={(event) => setIsAvailable(event.target.checked)}
              />
              <span>Cho phép bán</span>
            </label>

            <div className="nova-admin-actions">
              <Button variant="primary" type="submit" accessibleLabel={isEdit ? "Lưu thay đổi món" : "Thêm món mới"} busy={busy} busyLabel="Đang lưu…">
                {isEdit ? "Lưu thay đổi" : "Thêm món"}
              </Button>
              <Link className="nova-button nova-button--secondary" to="/admin/menu/categories">Hủy</Link>
            </div>
          </form>
        ) : null}
      </main>
    </AppShell>
  );
}
