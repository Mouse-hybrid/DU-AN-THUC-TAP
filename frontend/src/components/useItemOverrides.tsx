import { type MutableRefObject, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { refireItem, voidItem, type OrderItemDetail } from "../api/orders";
import { usePermissions } from "../auth/permissions";
import type { FlashMessage } from "../auth/storage";
import { createIdempotencyKey } from "../utils/idempotency";
import { orderErrorMessage } from "../utils/errorMessages";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";

const VOIDABLE_ITEM_STATUSES = new Set(["CREATED", "SENT", "ACCEPTED", "PREPARING"]);
const REFIRABLE_ITEM_STATUSES = new Set(["SERVED", "PICKED_UP"]);
/** Đơn đã yêu cầu thanh toán thì backend không cho hủy hoặc làm lại món. */
const LOCKED_ORDER_STATUSES = new Set(["BILLING", "PAID", "CLOSED"]);

const MAX_REASON_LENGTH = 255;

export type OverrideKind = "void" | "refire";

export function overrideKindsFor(orderStatus: string, itemStatus: string): OverrideKind[] {
  if (LOCKED_ORDER_STATUSES.has(orderStatus)) return [];
  if (VOIDABLE_ITEM_STATUSES.has(itemStatus)) return ["void"];
  if (REFIRABLE_ITEM_STATUSES.has(itemStatus)) return ["refire"];
  return [];
}

interface Pending {
  kind: OverrideKind;
  orderId: string;
  item: OrderItemDetail;
}

interface Options {
  /** Tải lại dữ liệu của màn sau khi thao tác (hoặc khi dữ liệu đã đổi). */
  reload: () => Promise<void>;
  notify: (message: FlashMessage) => void;
  /** Tập id món đang được thao tác để màn tự làm mới (polling) tạm dừng. */
  inFlight?: MutableRefObject<Set<string>>;
}

export interface ItemOverrides {
  /** Nút Hủy món / Làm lại cho 1 dòng món; null nếu vai trò hoặc trạng thái không cho phép. */
  actionsFor: (orderId: string, orderStatus: string, item: OrderItemDetail) => ReactNode;
  /** Mở hộp xác nhận cho nút riêng của màn (ví dụ màn chi tiết món bếp); null/no-op nếu đang bận. */
  request: (kind: OverrideKind, orderId: string, item: OrderItemDetail) => void;
  /** Hộp xác nhận, đặt 1 lần trong JSX của màn. */
  dialog: ReactNode;
  busy: boolean;
}

function inlineError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "Trạng thái món vừa thay đổi nên chưa thể thực hiện. Dữ liệu đã được tải lại.";
  }
  return orderErrorMessage(error);
}

export function useItemOverrides({ reload, notify, inFlight }: Options): ItemOverrides {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reasonError, setReasonError] = useState("");
  const reasonInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  // Một khóa cho mỗi lần mở hộp xác nhận: bấm lại sau lỗi mạng không tạo thao tác thứ hai.
  const keyRef = useRef("");

  const ask = useCallback((kind: OverrideKind, orderId: string, item: OrderItemDetail) => {
    if (running.current) return;
    keyRef.current = createIdempotencyKey();
    setReason("");
    setError("");
    setReasonError("");
    setPending({ kind, orderId, item });
  }, []);

  // Mở hộp hủy món thì đưa con trỏ vào ô lý do để nhập ngay.
  const pendingKind = pending?.kind;
  useEffect(() => {
    if (pendingKind === "void") reasonInput.current?.focus();
  }, [pendingKind]);

  function cancel() {
    if (running.current) return;
    setPending(null);
    setError("");
    setReasonError("");
  }

  async function confirm() {
    if (!pending || running.current) return;
    // Backend cho phép bỏ trống, nhưng nhóm đã chốt: hủy món bắt buộc có lý do để nhật ký truy vết được.
    if (pending.kind === "void" && !reason.trim()) {
      setReasonError("Vui lòng nhập lý do hủy món.");
      reasonInput.current?.focus();
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    const { kind, orderId, item } = pending;
    inFlight?.current.add(item.id);
    try {
      if (kind === "void") {
        await voidItem(orderId, item.id, { reason: reason.trim() }, keyRef.current);
      } else {
        await refireItem(orderId, item.id, keyRef.current);
      }
      setPending(null);
      await reload();
      notify({
        message: kind === "void" ? `Đã hủy món ${item.menu_item_name}.` : `Đã gửi lại ${item.menu_item_name} cho bếp làm lại.`,
        type: "success",
      });
    } catch (requestError) {
      if (requestError instanceof ApiError && (requestError.status === 409 || requestError.status === 404)) {
        setPending(null);
        await reload();
        notify({ message: inlineError(requestError), type: "error" });
      } else {
        setError(inlineError(requestError));
      }
    } finally {
      inFlight?.current.delete(item.id);
      running.current = false;
      setBusy(false);
    }
  }

  // Hủy/làm lại món là quyền OVERRIDE của backend; vai trò nào đang có quyền này do quản lý chỉnh ở màn 94.
  const allowed = usePermissions().can("OVERRIDE");

  const actionsFor = (orderId: string, orderStatus: string, item: OrderItemDetail): ReactNode => {
    if (!allowed) return null;
    const kinds = overrideKindsFor(orderStatus, item.status);
    if (kinds.length === 0) return null;
    return kinds.map((kind) => (
      <Button
        key={kind}
        variant={kind === "void" ? "danger" : "secondary"}
        type="button"
        className="nova-order-line-action"
        accessibleLabel={`${kind === "void" ? "Hủy món" : "Làm lại món"} ${item.menu_item_name}`}
        disabled={busy}
        onClick={() => ask(kind, orderId, item)}
      >
        {kind === "void" ? "Hủy món" : "Làm lại"}
      </Button>
    ));
  };

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.kind === "void" ? "Hủy món này?" : "Làm lại món này?"}
      confirmLabel={pending.kind === "void" ? "Hủy món" : "Làm lại món"}
      variant={pending.kind === "void" ? "danger" : "primary"}
      busy={busy}
      onCancel={cancel}
      onConfirm={() => void confirm()}
    >
      <p>
        <strong>{pending.item.quantity} × {pending.item.menu_item_name}</strong>
        {pending.kind === "void"
          ? ". Món bị loại khỏi đơn, không tính tiền và phiếu bếp đang chờ sẽ bị hủy."
          : ". Món quay lại hàng chờ của bếp; dòng món gốc vẫn được giữ trong lịch sử đơn."}
      </p>
      {pending.kind === "void" ? (
        <div className="nova-field">
          <label htmlFor="nova-void-reason">Lý do hủy món</label>
          <input
            id="nova-void-reason"
            ref={reasonInput}
            type="text"
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            required
            aria-required="true"
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? "nova-void-reason-error" : undefined}
            disabled={busy}
            placeholder="Ví dụ: khách đổi món"
            onChange={(event) => {
              setReason(event.target.value);
              if (event.target.value.trim()) setReasonError("");
              keyRef.current = createIdempotencyKey();
            }}
          />
          {reasonError ? <p className="nova-field-error" id="nova-void-reason-error" role="alert">{reasonError}</p> : null}
        </div>
      ) : null}
      {error ? <div className="nova-alert" role="alert">{error}</div> : null}
    </ConfirmDialog>
  ) : null;

  return { actionsFor, request: ask, dialog, busy };
}
