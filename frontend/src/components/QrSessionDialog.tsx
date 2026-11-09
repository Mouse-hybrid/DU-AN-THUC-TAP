import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { getQrSession, issueQrSession, revokeQrSession, type QrSession } from "../api/qr";
import { getErrorMessage } from "../api/client";
import { createIdempotencyKey } from "../utils/idempotency";
import { formatShortDateTime } from "../utils/format";
import { Button } from "./Button";
import { QrCode } from "./QrCode";

interface QrSessionDialogProps {
  tableId: string;
  tableCode: string;
  onClose: () => void;
}

function qrError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Bạn không có quyền quản lý mã QR.";
    if (error.status === 404) return "Không tìm thấy bàn.";
    if (error.status === 409) return "Bàn chưa mở phiên hoặc đang chờ thanh toán nên không cấp được mã QR.";
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Vui lòng thử lại.";
    if (error.status === 0) return navigator.onLine ? "Không thể kết nối máy chủ. Vui lòng thử lại." : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

/** Mã QR gọi món theo bàn (màn 107). Cấp lại thì mã cũ hết dùng. */
export function QrSessionDialog({ tableId, tableCode, onClose }: QrSessionDialogProps) {
  const [session, setSession] = useState<QrSession | null>(null);
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [busy, setBusy] = useState<"issue" | "revoke" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      setSession(await getQrSession(tableId));
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 404) setSession(null);
      else setError(qrError(loadError));
    } finally {
      setState("ready");
    }
  }, [tableId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !inFlight.current) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function run(kind: "issue" | "revoke") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setError("");
    try {
      if (kind === "issue") setSession(await issueQrSession(tableId, createIdempotencyKey()));
      else {
        await revokeQrSession(tableId, createIdempotencyKey());
        setSession(null);
      }
    } catch (runError) {
      setError(qrError(runError));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const link = session ? `${window.location.origin}${session.path}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Không sao chép được. Hãy chép đường dẫn thủ công.");
    }
  }

  return (
    <div className="nova-dialog-backdrop" role="presentation">
      <section className="nova-confirm-dialog nova-form-dialog nova-form-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="nova-qr-title">
        <h2 id="nova-qr-title">Mã QR gọi món · Bàn {tableCode}</h2>
        <div className="nova-form-dialog-body">
          {state === "loading" ? <p className="nova-readonly-note">Đang tải mã QR…</p> : null}
          {state === "ready" && !session ? (
            <p data-testid="qr-none">Bàn chưa có mã QR còn hạn. Cấp mã để khách quét và gọi món; món khách gọi sẽ chờ phục vụ xác nhận.</p>
          ) : null}
          {session ? (
            <div className="nova-qr-box" data-testid="qr-box">
              <QrCode value={link} label={`Mã QR gọi món bàn ${tableCode}`} />
              <p className="nova-qr-link" data-testid="qr-link">{link}</p>
              <p>Hết hạn: {formatShortDateTime(session.expires_at)}</p>
            </div>
          ) : null}
        </div>
        {error ? <div className="nova-alert" role="alert">{error}</div> : null}
        <div className="nova-confirm-actions">
          <Button variant="secondary" type="button" accessibleLabel="Đóng mã QR" disabled={busy !== null} onClick={onClose}>Đóng</Button>
          {session ? (
            <>
              <Button variant="secondary" type="button" accessibleLabel="Sao chép đường dẫn QR" onClick={() => void copy()}>{copied ? "Đã chép" : "Sao chép link"}</Button>
              <Button variant="danger" type="button" accessibleLabel="Thu hồi mã QR" busy={busy === "revoke"} disabled={busy !== null} onClick={() => void run("revoke")}>Thu hồi</Button>
              <Button variant="primary" type="button" accessibleLabel="Cấp lại mã QR" busy={busy === "issue"} disabled={busy !== null} onClick={() => void run("issue")}>Cấp lại</Button>
            </>
          ) : state === "ready" ? (
            <Button variant="primary" type="button" accessibleLabel="Cấp mã QR" busy={busy === "issue"} disabled={busy !== null} onClick={() => void run("issue")}>Cấp mã QR</Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
