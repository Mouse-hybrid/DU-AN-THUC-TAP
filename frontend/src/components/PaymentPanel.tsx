import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPayment,
  checkPayment,
  listPayments,
  recordPayment,
  refundPayment,
  type CreatePaymentBody,
  type OrderPayments,
  type PaymentRecord,
} from "../api/payments";
import { ApiError } from "../api/client";
import type { FlashMessage } from "../auth/storage";
import { paymentErrorMessage } from "../utils/errorMessages";
import { formatShortDateTime, formatVnd } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { QrCode } from "./QrCode";
import { StateCard } from "./StateCard";

type Method = "CASH" | "CARD" | "VNPAY";
type Dialog = { kind: "cancel" | "refund"; payment: PaymentRecord } | null;

interface PaymentPanelProps {
  orderId: string;
  orderStatus: string;
  /** Số phải trả của đơn. Đổi (áp/gỡ ưu đãi, đổi điểm) thì tải lại tóm tắt thanh toán. */
  orderTotal: string;
  /** Thu tiền (PROCESS_PAYMENT). */
  canRecord: boolean;
  /** Hủy lần thu / hoàn tiền (PAYMENT_REFUND). */
  canRefund: boolean;
  /** Khóa nút khi trang đang thực hiện thao tác khác. */
  locked: boolean;
  notify: (message: FlashMessage) => void;
  /** Tải lại đơn sau khi tiền đã đổi (đơn có thể vừa chuyển PAID). */
  onChanged: () => Promise<void>;
}

const METHOD_LABEL: Record<string, string> = { CASH: "Tiền mặt", CARD: "Thẻ", VNPAY: "VNPay" };
/** Link VNPay chưa có kết quả: còn giữ chỗ số tiền (nếu chưa hết hạn), hủy được. */
const WAITING = new Set(["PENDING", "UNKNOWN"]);
const POLL_MS = 5_000;

function paymentStatusLabel(payment: PaymentRecord): string {
  if (payment.status === "PENDING") return "Chờ khách trả";
  if (payment.status === "UNKNOWN") return "Chưa rõ kết quả";
  if (payment.status === "FAILED") return "Không thành công";
  if (payment.status === "EXPIRED") return "Link hết hạn";
  if (payment.status === "CANCELLED") return "Đã hủy";
  if (payment.status === "REFUNDED") return "Đã hoàn";
  if (Number(payment.refunded_amount) > 0) return "Hoàn một phần";
  return "Đã nhận";
}

function parseMoney(text: string): number | null {
  const normalized = text.trim().replace(/[.,\s]/g, "");
  if (normalized === "") return null;
  const value = Number(normalized);
  return Number.isFinite(value) && /^\d+$/.test(normalized) ? value : Number.NaN;
}

export function PaymentPanel({ orderId, orderStatus, orderTotal, canRecord, canRefund, locked, notify, onChanged }: PaymentPanelProps) {
  const [data, setData] = useState<OrderPayments | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [method, setMethod] = useState<Method>("CASH");
  const [amountText, setAmountText] = useState("");
  const [cashText, setCashText] = useState("");
  const [providerRef, setProviderRef] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState("");
  const [refundText, setRefundText] = useState("");
  const [dialogError, setDialogError] = useState("");
  const inFlight = useRef(false);
  const hasLoaded = useRef(false);

  const load = useCallback(async () => {
    if (!hasLoaded.current) setState("loading");
    try {
      setData(await listPayments(orderId));
      hasLoaded.current = true;
      setError("");
      setState("ready");
    } catch (loadError) {
      setError(paymentErrorMessage(loadError, "Dữ liệu thanh toán vừa thay đổi. Vui lòng tải lại."));
      setState(hasLoaded.current ? "ready" : "error");
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load, orderStatus, orderTotal]);

  const waitingLink = data?.payments.find((payment) => payment.method === "VNPAY" && WAITING.has(payment.status)) ?? null;
  const waitingId = waitingLink?.id ?? null;
  useEffect(() => {
    if (!waitingId) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      void listPayments(orderId).then((next) => {
        setData(next);
        const still = next.payments.find((payment) => payment.id === waitingId);
        if (still && !WAITING.has(still.status)) {
          notify({ message: still.status === "SUCCEEDED" ? `Khách đã trả ${formatVnd(still.amount)} qua VNPay.` : "Link VNPay đã kết thúc, chưa thu được tiền.", type: still.status === "SUCCEEDED" ? "success" : "error" });
          void onChanged();
        }
      }).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [waitingId, orderId, notify, onChanged]);

  // Chia tiền: theo số khách hoặc theo %. Chỉ tính sẵn số tiền của lần thu này, vẫn thu từng lần.
  const [splitPeople, setSplitPeople] = useState("");
  const [splitPercent, setSplitPercent] = useState("");

  const summary = data?.summary;
  const remaining = summary ? Number(summary.remaining) : 0;
  const amountValue = amountText.trim() === "" ? remaining : parseMoney(amountText);
  const cashValue = cashText.trim() === "" ? amountValue : parseMoney(cashText);
  const change = method === "CASH" && amountValue !== null && cashValue !== null && Number.isFinite(amountValue) && Number.isFinite(cashValue)
    ? cashValue - amountValue
    : null;
  const pendingAmount = summary ? Number(summary.pending ?? 0) : 0;
  const showForm = canRecord && orderStatus === "BILLING" && remaining > 0 && !waitingLink;

  /** Chạy một thao tác ghi với chống bấm đúp; 404/409 thì tải lại dữ liệu để thấy số mới. */
  async function run(
    task: (key: string) => Promise<string>,
    conflict: string,
    mapError?: (failure: unknown) => string | null,
  ): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      notify({ message: await task(createIdempotencyKey()), type: "success" });
      await Promise.all([load(), onChanged()]);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) {
        await Promise.all([load(), onChanged()]);
      }
      const message = mapError?.(failure) ?? paymentErrorMessage(failure, conflict);
      if (dialog) setDialogError(message);
      else setFormError(message);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function submitPayment() {
    setFormError("");
    if (amountValue === null || !Number.isFinite(amountValue) || amountValue <= 0) {
      setFormError("Số tiền phải là số nguyên lớn hơn 0.");
      return;
    }
    if (amountValue > remaining) {
      setFormError(`Không thu quá số còn lại (${formatVnd(String(remaining))}).`);
      return;
    }
    if (method === "CASH" && (cashValue === null || !Number.isFinite(cashValue) || cashValue < amountValue)) {
      setFormError("Tiền khách đưa chưa đủ so với số thu.");
      return;
    }
    const body: CreatePaymentBody = { method, amount: String(amountValue) };
    if (method === "VNPAY") {
      const ok = await run(async (key) => {
        await recordPayment(orderId, body, key);
        return "Đã tạo link VNPay. Đưa mã QR hoặc link cho khách để trả.";
      }, "Số còn phải thu vừa thay đổi hoặc đang có link VNPay khác. Dữ liệu đã được tải lại.");
      if (ok) { setAmountText(""); setNote(""); }
      return;
    }
    if (method === "CASH" && cashText.trim() !== "") body.cash_received = String(cashValue);
    if (method === "CARD" && providerRef.trim() !== "") body.provider_ref = providerRef.trim();
    if (note.trim() !== "") body.note = note.trim();
    const ok = await run(async (key) => {
      const result = await recordPayment(orderId, body, key);
      const changeDue = Number(result.payment.change_due ?? 0);
      const paidInFull = result.order_status === "PAID";
      const base = method === "CASH" ? "Đã nhận tiền mặt" : "Đã ghi nhận thanh toán thẻ";
      const tail = changeDue > 0 ? `. Tiền thối ${formatVnd(String(changeDue))}` : "";
      return `${base}${tail}${paidInFull ? ". Đơn đã thanh toán đủ." : "."}`;
    }, "Số còn phải thu vừa thay đổi hoặc đơn đã được thanh toán. Dữ liệu đã được tải lại.");
    if (ok) {
      setAmountText("");
      setCashText("");
      setProviderRef("");
      setNote("");
    }
  }

  async function recheck(payment: PaymentRecord) {
    await run(async (key) => {
      const result = await checkPayment(payment.id, key);
      if (result.payment.status === "SUCCEEDED") return `VNPay xác nhận đã nhận ${formatVnd(result.payment.amount)}.`;
      if (WAITING.has(result.payment.status)) return "VNPay chưa có kết quả. Khách chưa trả xong hoặc cần thử lại sau.";
      return "Link VNPay không thành công. Có thể tạo link mới hoặc thu cách khác.";
    }, "Trạng thái thanh toán vừa đổi. Dữ liệu đã được tải lại.", (failure) =>
      // 502/503: chưa hỏi được VNPay (sandbox đang lỗi tra cứu). Không phải hệ thống hỏng,
      // và kết quả khách trả vẫn về qua trang trả về của VNPay.
      failure instanceof ApiError && (failure.status === 502 || failure.status === 503)
        ? "Chưa hỏi được VNPay lúc này. Nếu khách đã trả xong, màn này vẫn tự cập nhật trong vài giây; chưa cần thu lại."
        : null);
  }

  function applySplit(kind: "people" | "percent") {
    const base = Number(summary?.total ?? 0);
    if (kind === "people") {
      const people = Number(splitPeople);
      if (!Number.isInteger(people) || people < 2 || people > 50) { setFormError("Số người chia từ 2 đến 50."); return; }
      // Làm tròn lên tới đồng; lần thu cuối chỉ lấy đúng phần còn lại.
      setAmountText(String(Math.min(remaining, Math.ceil(base / people))));
    } else {
      const percent = Number(splitPercent);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) { setFormError("Phần trăm từ 1 đến 100."); return; }
      setAmountText(String(Math.min(remaining, Math.round((base * percent) / 100))));
    }
    setFormError("");
  }

  function openDialog(kind: "cancel" | "refund", payment: PaymentRecord) {
    setReason("");
    setRefundText("");
    setDialogError("");
    setDialog({ kind, payment });
  }

  async function confirmDialog() {
    if (!dialog) return;
    setDialogError("");
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setDialogError("Lý do cần ít nhất 3 ký tự.");
      return;
    }
    const { kind, payment } = dialog;
    let refundAmount: string | undefined;
    if (kind === "refund" && refundText.trim() !== "") {
      const value = parseMoney(refundText);
      const refundable = Number(payment.amount) - Number(payment.refunded_amount);
      if (value === null || !Number.isFinite(value) || value <= 0 || value > refundable) {
        setDialogError(`Số hoàn phải từ 1 đến ${formatVnd(String(refundable))}.`);
        return;
      }
      refundAmount = String(value);
    }
    const ok = await run(async (key) => {
      if (kind === "cancel") {
        await cancelPayment(payment.id, trimmed, key);
        return WAITING.has(payment.status) ? "Đã hủy link VNPay." : "Đã hủy lần thanh toán.";
      }
      await refundPayment(payment.id, refundAmount === undefined ? { reason: trimmed } : { amount: refundAmount, reason: trimmed }, key);
      return "Đã hoàn tiền.";
    }, kind === "cancel"
      ? "Không hủy được: đơn đã thanh toán đủ hoặc lần này đã bị hủy. Dữ liệu đã được tải lại."
      : "Không hoàn được: số tiền vượt phần còn có thể hoàn hoặc trạng thái đã đổi. Dữ liệu đã được tải lại.");
    if (ok) setDialog(null);
  }

  if (state === "loading") return <StateCard kind="loading" title="Đang tải thanh toán" message="Vui lòng chờ trong giây lát." />;
  if (state === "error") return <StateCard kind="error" title="Không thể tải thanh toán" message={error} onRetry={() => void load()} />;
  if (!data || !summary) return null;
  if (!showForm && data.payments.length === 0) return null;

  const disabled = busy || locked;
  const cancelable = orderStatus === "BILLING" && canRefund;
  const refundable = (orderStatus === "PAID" || orderStatus === "CLOSED") && canRefund;

  return (
    <section className="nova-payment-panel" aria-label="Thanh toán">
      <h2>Thanh toán</h2>
      <dl className="nova-payment-totals">
        <div><dt>Phải trả</dt><dd data-testid="pay-total">{formatVnd(summary.total)}</dd></div>
        <div><dt>Đã thu</dt><dd data-testid="pay-paid">{formatVnd(summary.paid)}</dd></div>
        {Number(summary.refunded) > 0 ? <div><dt>Đã hoàn</dt><dd>{formatVnd(summary.refunded)}</dd></div> : null}
        {pendingAmount > 0 ? <div><dt>Chờ VNPay</dt><dd data-testid="pay-pending">{formatVnd(String(pendingAmount))}</dd></div> : null}
        <div className="nova-payment-remaining"><dt>Còn lại</dt><dd data-testid="pay-remaining">{formatVnd(summary.remaining)}</dd></div>
      </dl>
      {error ? <p className="nova-readonly-note" role="alert">{error}</p> : null}

      {waitingLink ? (
        <div className="nova-vnpay-card" data-testid="vnpay-waiting" role="status">
          <div className="nova-vnpay-card-head">
            <strong>Chờ khách trả qua VNPay · {formatVnd(waitingLink.amount)}</strong>
            {waitingLink.expires_at ? <span>Hết hạn {formatShortDateTime(waitingLink.expires_at)}</span> : null}
          </div>
          {waitingLink.payment_url ? (
            <>
              <QrCode value={waitingLink.payment_url} size={200} label={`Mã QR thanh toán VNPay ${formatVnd(waitingLink.amount)}`} />
              <a className="nova-vnpay-link" href={waitingLink.payment_url} target="_blank" rel="noopener noreferrer">Mở trang thanh toán VNPay</a>
            </>
          ) : null}
          <p className="nova-field-hint">Khách quét mã bằng điện thoại hoặc mở link. Trả xong, màn này tự cập nhật trong vài giây.</p>
          <div className="nova-vnpay-actions">
            <Button variant="secondary" type="button" accessibleLabel="Kiểm tra lại kết quả VNPay" busy={busy} disabled={locked} onClick={() => void recheck(waitingLink)}>Kiểm tra lại</Button>
            {canRecord ? (
              <Button variant="secondary" type="button" accessibleLabel="Hủy link VNPay" disabled={busy || locked} onClick={() => openDialog("cancel", waitingLink)}>Hủy link</Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {data.payments.length > 0 ? (
        <ul className="nova-payment-list" aria-label="Các lần thanh toán">
          {data.payments.map((payment) => {
            const left = Number(payment.amount) - Number(payment.refunded_amount);
            return (
              <li key={payment.id} data-testid="payment-row" className={payment.status === "CANCELLED" ? "nova-payment-row--cancelled" : undefined}>
                <div>
                  <strong>{METHOD_LABEL[payment.method] ?? payment.method} · {formatVnd(payment.amount)}</strong>
                  <span className="nova-payment-status">{paymentStatusLabel(payment)}</span>
                  <p>
                    {formatShortDateTime(payment.created_at)}
                    {payment.method === "CASH" && payment.cash_received ? ` · Khách đưa ${formatVnd(payment.cash_received)}` : ""}
                    {payment.change_due && Number(payment.change_due) > 0 ? ` · Thối ${formatVnd(payment.change_due)}` : ""}
                    {payment.method === "CARD" && payment.provider_ref ? ` · Hóa đơn máy ${payment.provider_ref}` : ""}
                    {payment.provider_txn_no ? ` · Mã GD VNPay ${payment.provider_txn_no}` : ""}
                    {Number(payment.refunded_amount) > 0 ? ` · Đã hoàn ${formatVnd(payment.refunded_amount)}` : ""}
                    {payment.cancel_reason ? ` · Lý do hủy: ${payment.cancel_reason}` : ""}
                  </p>
                </div>
                {payment.status === "SUCCEEDED" && cancelable ? (
                  <Button variant="secondary" type="button" className="nova-order-line-action" accessibleLabel={`Hủy lần thanh toán ${formatVnd(payment.amount)}`} disabled={disabled} onClick={() => openDialog("cancel", payment)}>Hủy</Button>
                ) : null}
                {payment.status === "SUCCEEDED" && refundable && left > 0 ? (
                  <Button variant="secondary" type="button" className="nova-order-line-action" accessibleLabel={`Hoàn tiền lần thanh toán ${formatVnd(payment.amount)}`} disabled={disabled} onClick={() => openDialog("refund", payment)}>Hoàn tiền</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {showForm ? (
        <form
          className="nova-payment-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPayment();
          }}
        >
          <fieldset className="nova-payment-methods">
            <legend>Hình thức</legend>
            {(["CASH", "CARD", "VNPAY"] as const).map((value) => (
              <label key={value} className={`nova-pill${method === value ? " nova-pill--active" : ""}`}>
                <input type="radio" name="payment-method" value={value} checked={method === value} onChange={() => { setMethod(value); setFormError(""); }} className="nova-visually-hidden" />
                {METHOD_LABEL[value]}
              </label>
            ))}
          </fieldset>
          <label className="nova-field">
            <span>Số tiền thu (để trống = thu hết {formatVnd(summary.remaining)})</span>
            <input inputMode="numeric" value={amountText} onChange={(event) => setAmountText(event.target.value)} placeholder={String(remaining)} />
          </label>
          <div className="nova-payment-split" aria-label="Chia tiền">
            <label className="nova-field">
              <span>Chia đều cho (người)</span>
              <input inputMode="numeric" value={splitPeople} onChange={(event) => setSplitPeople(event.target.value)} placeholder="vd 3" />
            </label>
            <Button variant="secondary" type="button" accessibleLabel="Tính số tiền mỗi người" disabled={busy || locked || splitPeople.trim() === ""} onClick={() => applySplit("people")}>Tính</Button>
            <label className="nova-field">
              <span>Hoặc theo %</span>
              <input inputMode="numeric" value={splitPercent} onChange={(event) => setSplitPercent(event.target.value)} placeholder="vd 40" />
            </label>
            <Button variant="secondary" type="button" accessibleLabel="Tính số tiền theo phần trăm" disabled={busy || locked || splitPercent.trim() === ""} onClick={() => applySplit("percent")}>Tính</Button>
          </div>
          {method === "CASH" ? (
            <>
              <label className="nova-field">
                <span>Khách đưa (để trống = đưa vừa đủ)</span>
                <input inputMode="numeric" value={cashText} onChange={(event) => setCashText(event.target.value)} />
              </label>
              <p className="nova-payment-change" data-testid="pay-change" role="status">
                {change === null ? "Tiền thối: —" : change < 0 ? "Khách đưa chưa đủ" : `Tiền thối: ${formatVnd(String(change))}`}
              </p>
            </>
          ) : method === "CARD" ? (
            <label className="nova-field">
              <span>Số hóa đơn trên máy POS (nếu có)</span>
              <input value={providerRef} maxLength={100} onChange={(event) => setProviderRef(event.target.value)} />
            </label>
          ) : (
            <p className="nova-field-hint">Tạo link VNPay (hạn 15 phút). Khách quét mã QR hoặc mở link để trả; chưa trả xong thì chưa tính là đã thu.</p>
          )}
          <label className="nova-field">
            <span>Ghi chú (không bắt buộc)</span>
            <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
          </label>
          {method === "CARD" ? <p className="nova-field-hint">Chỉ ghi nhận sau khi máy POS đã quẹt thành công.</p> : null}
          {formError ? <div className="nova-alert" role="alert">{formError}</div> : null}
          <Button variant="primary" type="submit" accessibleLabel={method === "VNPAY" ? "Tạo link VNPay" : "Ghi nhận thanh toán"} busy={busy} disabled={locked}>{method === "VNPAY" ? "Tạo link VNPay" : "Ghi nhận thanh toán"}</Button>
        </form>
      ) : formError ? <div className="nova-alert" role="alert">{formError}</div> : null}

      {dialog ? (
        <ConfirmDialog
          title={dialog.kind === "cancel" ? (WAITING.has(dialog.payment.status) ? "Hủy link VNPay?" : "Hủy lần thanh toán?") : "Hoàn tiền?"}
          confirmLabel={dialog.kind === "cancel" ? (WAITING.has(dialog.payment.status) ? "Hủy link" : "Hủy lần thanh toán") : "Hoàn tiền"}
          variant="danger"
          busy={busy}
          onCancel={() => { if (!busy) setDialog(null); }}
          onConfirm={() => void confirmDialog()}
        >
          <p>
            {dialog.kind === "cancel" && WAITING.has(dialog.payment.status)
              ? `Link VNPay ${formatVnd(dialog.payment.amount)} sẽ không dùng được nữa. Sau đó có thể thu tiền mặt, thẻ hoặc tạo link mới.`
              : dialog.kind === "cancel"
              ? `Lần thu ${formatVnd(dialog.payment.amount)} sẽ bị hủy và số còn lại của đơn tăng lên.`
              : `Hoàn lại cho khách, tối đa ${formatVnd(String(Number(dialog.payment.amount) - Number(dialog.payment.refunded_amount)))}.`}
          </p>
          {dialog.kind === "refund" ? (
            <label className="nova-field">
              <span>Số tiền hoàn (để trống = hoàn hết)</span>
              <input inputMode="numeric" value={refundText} onChange={(event) => setRefundText(event.target.value)} />
            </label>
          ) : null}
          <label className="nova-field">
            <span>Lý do (bắt buộc)</span>
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </label>
          {dialogError ? <div className="nova-alert" role="alert">{dialogError}</div> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
