import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  getQrMenu,
  getQrOrder,
  getQrTable,
  requestQrBill,
  submitQrMember,
  submitQrOrder,
  type QrMenu,
  type QrMenuItem,
  type QrOrder,
  type QrTableInfo,
} from "../api/qr";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MenuThumb } from "../components/MenuThumb";
import { ModifierDialog } from "../components/ModifierDialog";
import { StatusBadge } from "../components/StatusBadge";
import { formatVnd } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";

interface CartLine {
  key: string;
  item: QrMenuItem;
  optionIds: string[];
  optionLabel: string;
  unitPrice: number;
  quantity: number;
  note: string;
}

const MAX_LINES = 20;
const MAX_QTY = 20;
// Khớp giới hạn `note` của API (QrOrderLine.note, tối đa 200 ký tự).
const MAX_NOTE = 200;

function fatalMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Mã QR không còn hiệu lực (đã được thay bằng mã mới hoặc bị thu hồi). Vui lòng nhờ nhân viên cấp mã mới.";
    if (error.status === 410) return "Mã QR đã hết hạn hoặc bàn đã thanh toán xong. Vui lòng nhờ nhân viên hỗ trợ.";
    if (error.status === 429) return "Quá nhiều lượt truy cập. Vui lòng thử lại sau vài giây.";
    if (error.status === 0) return navigator.onLine ? "Không thể kết nối. Vui lòng thử lại." : "Bạn đang ngoại tuyến.";
  }
  return "Không thể mở trang gọi món. Vui lòng thử lại hoặc nhờ nhân viên hỗ trợ.";
}

function submitMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 410) return fatalMessage(error);
    if (error.status === 409) return error.serverDetail ?? "Không gửi được: có món hết hàng hoặc bàn đang chờ thanh toán. Vui lòng kiểm tra lại hoặc gọi nhân viên.";
    if (error.status === 422) return error.message || "Món hoặc tùy chọn chưa hợp lệ.";
    if (error.status === 429) return "Quá nhiều lượt truy cập. Vui lòng thử lại sau vài giây.";
    if (error.status === 0) return navigator.onLine ? "Không thể kết nối. Giỏ hàng vẫn được giữ, vui lòng thử lại." : "Bạn đang ngoại tuyến. Giỏ hàng vẫn được giữ.";
  }
  return "Không gửi được món. Giỏ hàng vẫn được giữ, vui lòng thử lại.";
}

/** Trang khách quét mã QR tại bàn: không đăng nhập, token trong URL là quyền truy cập duy nhất. */
export function QrOrderPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [info, setInfo] = useState<QrTableInfo | null>(null);
  const [menu, setMenu] = useState<QrMenu | null>(null);
  const [placed, setPlaced] = useState<QrOrder | null>(null);
  const [fatal, setFatal] = useState("");
  const [category, setCategory] = useState("ALL");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [picking, setPicking] = useState<QrMenuItem | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "error" } | null>(null);
  // Lần gửi đầu, khách xác nhận đúng bàn (quét nhầm mã bàn khác thì dừng lại hỏi nhân viên).
  const confirmKey = `nova-qr-table-ok:${token}`;
  const [tableConfirmed, setTableConfirmed] = useState(() => {
    try { return window.sessionStorage.getItem(confirmKey) === "1"; } catch { return false; }
  });
  const [askTable, setAskTable] = useState(false);
  const [billBusy, setBillBusy] = useState(false);
  const [memberPhone, setMemberPhone] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberMessage, setMemberMessage] = useState<{ text: string; type: "ok" | "error" } | null>(null);
  const inFlight = useRef(false);
  // Giữ Idempotency-Key của lần gửi đang thử lại để bấm lại không tạo trùng món.
  const pendingKey = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => { document.title = "Gọi món tại bàn · NOVA"; }, []);

  const loadPlaced = useCallback(async () => {
    try {
      setPlaced(await getQrOrder(token));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 410)) setFatal(fatalMessage(error));
    }
  }, [token]);

  useEffect(() => {
    let active = true;
    Promise.all([getQrTable(token), getQrMenu(token)])
      .then(([tableInfo, menuData]) => {
        if (!active) return;
        setInfo(tableInfo);
        setMenu(menuData);
        void loadPlaced();
      })
      .catch((error: unknown) => { if (active) setFatal(fatalMessage(error)); });
    return () => { active = false; };
  }, [token, loadPlaced]);

  // Phía khách không có WebSocket: hỏi lại định kỳ để thấy trạng thái món.
  useEffect(() => {
    if (!info) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void loadPlaced();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [info, loadPlaced]);

  const items = useMemo(
    () => (menu?.items ?? []).filter((item) => category === "ALL" || item.category_id === category),
    [menu, category],
  );
  const total = cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  const locked = info?.ordering_locked ?? false;
  // DIRECT: món vào bếp ngay; CONFIRM: chờ nhân viên xác nhận (cài đặt của cửa hàng).
  const direct = (info?.send_mode ?? "DIRECT") === "DIRECT";

  function addLine(item: QrMenuItem, optionIds: string[]) {
    setMessage(null);
    const options = item.modifier_groups.flatMap((group) => group.options).filter((option) => optionIds.includes(option.id));
    const unitPrice = Number(item.price) + options.reduce((sum, option) => sum + Number(option.price_delta), 0);
    const key = `${item.id}|${[...optionIds].sort().join(",")}`;
    setCart((current) => {
      const existing = current.find((line) => line.key === key);
      if (existing) {
        return current.map((line) => line.key === key ? { ...line, quantity: Math.min(MAX_QTY, line.quantity + 1) } : line);
      }
      if (current.length >= MAX_LINES) return current;
      return [...current, { key, item, optionIds, optionLabel: options.map((option) => option.name).join(", "), unitPrice, quantity: 1, note: "" }];
    });
  }

  function onAdd(item: QrMenuItem) {
    if (!item.is_available) return;
    if (item.modifier_groups.some((group) => group.is_active)) setPicking(item);
    else addLine(item, []);
  }

  function changeNote(key: string, note: string) {
    setCart((current) => current.map((line) => line.key === key ? { ...line, note: note.slice(0, MAX_NOTE) } : line));
  }

  function changeQty(key: string, delta: number) {
    setCart((current) => current
      .map((line) => line.key === key ? { ...line, quantity: Math.min(MAX_QTY, line.quantity + delta) } : line)
      .filter((line) => line.quantity > 0));
  }

  function confirmTable() {
    try { window.sessionStorage.setItem(confirmKey, "1"); } catch { /* trình duyệt chặn lưu: hỏi lại lần sau */ }
    setTableConfirmed(true);
    setAskTable(false);
    void submit(true);
  }

  async function requestBill() {
    if (inFlight.current || locked) return;
    inFlight.current = true;
    setBillBusy(true);
    setMessage(null);
    try {
      setPlaced(await requestQrBill(token, createIdempotencyKey()));
      setInfo(await getQrTable(token));
      setMessage({ text: "Đã báo nhân viên mang hóa đơn. Vui lòng chờ trong giây lát.", type: "ok" });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 410)) setFatal(fatalMessage(error));
      else setMessage({ text: error instanceof ApiError && error.serverDetail ? error.serverDetail : "Chưa gửi được yêu cầu. Vui lòng thử lại hoặc gọi nhân viên.", type: "error" });
    } finally {
      inFlight.current = false;
      setBillBusy(false);
    }
  }

  async function submitMember() {
    const phone = memberPhone.replace(/[\s.-]/g, "");
    if (!/^0\d{9}$/.test(phone)) {
      setMemberMessage({ text: "Số điện thoại gồm 10 chữ số, bắt đầu bằng 0.", type: "error" });
      return;
    }
    setMemberBusy(true);
    setMemberMessage(null);
    try {
      const result = await submitQrMember(token, phone, createIdempotencyKey());
      setMemberPhone("");
      setMemberMessage({ text: `Đã nhận số ${result.phone_masked}. Điểm được tích khi thanh toán (nhân viên xác nhận nếu bạn chưa là hội viên).`, type: "ok" });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 410)) setFatal(fatalMessage(error));
      else setMemberMessage({ text: error instanceof ApiError && error.serverDetail ? error.serverDetail : "Chưa gửi được số điện thoại. Vui lòng thử lại.", type: "error" });
    } finally {
      setMemberBusy(false);
    }
  }

  async function submit(confirmed = tableConfirmed) {
    if (inFlight.current || cart.length === 0 || locked) return;
    if (!confirmed) {
      setAskTable(true);
      return;
    }
    inFlight.current = true;
    setSending(true);
    setMessage(null);
    const lines = cart.map((line) => ({
      menu_item_id: line.item.id,
      quantity: line.quantity,
      note: line.note.trim() || null,
      ...(line.optionIds.length > 0 ? { modifier_option_ids: line.optionIds } : {}),
    }));
    const signature = JSON.stringify(lines);
    const key = pendingKey.current?.signature === signature ? pendingKey.current.key : createIdempotencyKey();
    pendingKey.current = { signature, key };
    try {
      await submitQrOrder(token, lines, key);
      pendingKey.current = null;
      setCart([]);
      setMessage({ text: direct ? "Đã gửi món vào bếp. Món sẽ được phục vụ trong ít phút." : "Đã gửi món. Nhân viên sẽ xác nhận trong giây lát.", type: "ok" });
      await loadPlaced();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 410)) setFatal(fatalMessage(error));
      else {
        if (error instanceof ApiError && error.status !== 0) pendingKey.current = null;
        setMessage({ text: submitMessage(error), type: "error" });
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  if (fatal) {
    return (
      <main className="nova-qr-page">
        <section className="nova-state-card" role="alert" data-testid="qr-fatal">
          <h1>Không mở được trang gọi món</h1>
          <p>{fatal}</p>
        </section>
      </main>
    );
  }
  if (!info || !menu) {
    return <main className="nova-qr-page"><p className="nova-readonly-note" role="status">Đang tải thực đơn…</p></main>;
  }

  return (
    <main className="nova-qr-page">
      <header className="nova-qr-header">
        <p className="nova-eyebrow">NOVA · Gọi món tại bàn</p>
        <h1 data-testid="qr-table">Bàn {info.table_code}</h1>
        {info.area_name ? <p>{info.area_name}</p> : null}
      </header>

      {locked ? <p className="nova-alert" role="alert">Bàn đang chờ thanh toán nên tạm dừng gọi món. Vui lòng gọi nhân viên.</p> : null}
      {message ? <p className={message.type === "ok" ? "nova-qr-ok" : "nova-alert"} role={message.type === "ok" ? "status" : "alert"}>{message.text}</p> : null}

      <nav className="nova-qr-cats" aria-label="Danh mục">
        <button type="button" className={`nova-pill${category === "ALL" ? " nova-pill--active" : ""}`} aria-pressed={category === "ALL"} onClick={() => setCategory("ALL")}>Tất cả</button>
        {menu.categories.map((cat) => (
          <button key={cat.id} type="button" className={`nova-pill${category === cat.id ? " nova-pill--active" : ""}`} aria-pressed={category === cat.id} onClick={() => setCategory(cat.id)}>{cat.name}</button>
        ))}
      </nav>

      <ul className="nova-qr-menu" aria-label="Thực đơn">
        {items.map((item) => (
          <li key={item.id} className="nova-qr-item" data-testid="qr-menu-item">
            <MenuThumb name={item.name} className="nova-qr-thumb" />
            <div className="nova-qr-item-text"><strong>{item.name}</strong><small>{formatVnd(item.price)}{item.is_available ? "" : " · Hết món"}</small></div>
            <Button variant="primary" type="button" accessibleLabel={`Thêm ${item.name}`} disabled={!item.is_available || locked} onClick={() => onAdd(item)}>Thêm</Button>
          </li>
        ))}
      </ul>

      <section className="nova-qr-cart" aria-label="Giỏ hàng" data-testid="qr-cart">
        <h2>Giỏ hàng ({count})</h2>
        {cart.length === 0 ? <p className="nova-readonly-note">Chưa chọn món nào.</p> : (
          <ul>
            {cart.map((line) => (
              <li key={line.key} className="nova-qr-line nova-qr-line--cart">
                <div className="nova-qr-line-main">
                  <MenuThumb name={line.item.name} className="nova-qr-thumb nova-qr-thumb--small" />
                  <div className="nova-qr-item-text">
                    <strong>{line.item.name}</strong>
                    {line.optionLabel ? <small>{line.optionLabel}</small> : null}
                    <small>{formatVnd(String(line.unitPrice))}</small>
                  </div>
                  <div className="nova-split-stepper">
                    <button type="button" aria-label={`Giảm ${line.item.name}`} onClick={() => changeQty(line.key, -1)}>−</button>
                    <output aria-label={`Số lượng ${line.item.name}`}>{line.quantity}</output>
                    <button type="button" aria-label={`Tăng ${line.item.name}`} disabled={line.quantity >= MAX_QTY} onClick={() => changeQty(line.key, 1)}>+</button>
                  </div>
                </div>
                <label className="nova-qr-note">
                  <span>Ghi chú cho bếp</span>
                  <input type="text" value={line.note} maxLength={MAX_NOTE} placeholder="Ví dụ: ít cay, không hành" aria-label={`Ghi chú cho ${line.item.name}`} onChange={(event) => changeNote(line.key, event.target.value)} />
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="nova-order-total"><span>Tạm tính</span><strong data-testid="qr-cart-total">{formatVnd(String(total))}</strong></div>
        <p className="nova-readonly-note">{direct ? "Món gửi xong sẽ vào bếp ngay, không sửa được sau khi gửi." : "Món gửi xong sẽ chờ nhân viên xác nhận trước khi vào bếp."}</p>
        <Button variant="primary" type="button" accessibleLabel={direct ? "Gửi món vào bếp" : "Gửi món cho nhân viên"} busy={sending} disabled={cart.length === 0 || locked} onClick={() => void submit()}>Gửi món</Button>
      </section>

      <section className="nova-qr-placed" aria-label="Món đã gọi" data-testid="qr-placed">
        <h2>Món đã gọi</h2>
        {!placed || placed.items.length === 0 ? <p className="nova-readonly-note">Chưa có món nào.</p> : (
          <ul>
            {placed.items.map((item) => (
              <li key={item.id} className="nova-qr-line">
                <div>
                  <strong>{item.quantity} × {item.menu_item_name}</strong>
                  {item.modifiers.length > 0 ? <small>{item.modifiers.map((m) => m.option_name).join(", ")}</small> : null}
                  {item.note ? <small>Ghi chú: {item.note}</small> : null}
                </div>
                {item.status === "CREATED" ? <StatusBadge status={item.status} label="Chờ xác nhận" /> : <StatusBadge status={item.status} />}
              </li>
            ))}
          </ul>
        )}
        {placed && Number(placed.discount_total) > 0 ? <div className="nova-order-total"><span>Ưu đãi</span><strong>−{formatVnd(placed.discount_total)}</strong></div> : null}
        {placed ? <div className="nova-order-total"><span>Tổng</span><strong>{formatVnd(placed.total)}</strong></div> : null}
        {placed && placed.items.some((item) => item.status !== "CREATED" && item.status !== "VOIDED") ? (
          locked
            ? <p className="nova-readonly-note">Đã yêu cầu thanh toán. Nhân viên sẽ mang hóa đơn tới bàn.</p>
            : <Button variant="secondary" type="button" accessibleLabel="Yêu cầu thanh toán" busy={billBusy} onClick={() => void requestBill()}>Yêu cầu thanh toán</Button>
        ) : null}
      </section>

      <section className="nova-qr-placed" aria-label="Tích điểm" data-testid="qr-member">
        <h2>Tích điểm hội viên</h2>
        <p className="nova-readonly-note">Không bắt buộc. Nhập số điện thoại để tích điểm cho hóa đơn này.</p>
        <form className="nova-qr-member" onSubmit={(event) => { event.preventDefault(); void submitMember(); }} noValidate>
          <label className="nova-qr-note">
            <span>Số điện thoại</span>
            <input type="tel" inputMode="tel" autoComplete="tel" value={memberPhone} maxLength={15} placeholder="09xxxxxxxx" onChange={(event) => { setMemberPhone(event.target.value); setMemberMessage(null); }} />
          </label>
          <Button variant="secondary" type="submit" accessibleLabel="Gửi số điện thoại tích điểm" busy={memberBusy} disabled={memberPhone.trim() === ""}>Tích điểm</Button>
        </form>
        {memberMessage ? <p className={memberMessage.type === "ok" ? "nova-qr-ok" : "nova-alert"} role={memberMessage.type === "ok" ? "status" : "alert"}>{memberMessage.text}</p> : null}
      </section>

      {askTable ? (
        <ConfirmDialog
          title={`Bạn đang ngồi ở bàn ${info.table_code}?`}
          confirmLabel={`Đúng, bàn ${info.table_code}`}
          busy={sending}
          onCancel={() => setAskTable(false)}
          onConfirm={confirmTable}
        >
          <p>Món sẽ được mang tới bàn {info.table_code}{info.area_name ? ` (${info.area_name})` : ""}. Nếu không đúng bàn, vui lòng gọi nhân viên để lấy mã QR của bàn bạn.</p>
        </ConfirmDialog>
      ) : null}

      {picking ? (
        <ModifierDialog
          item={picking}
          groups={picking.modifier_groups}
          onCancel={() => setPicking(null)}
          onConfirm={(ids) => { const item = picking; setPicking(null); addLine(item, ids); }}
        />
      ) : null}
    </main>
  );
}
