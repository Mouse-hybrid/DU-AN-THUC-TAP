import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../api/client";
import { getOutletSettings, updateOutletSettings, type OutletSettings } from "../api/outlet";
import type { FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { StateCard } from "../components/StateCard";
import { Toast } from "../components/Toast";
import { createIdempotencyKey } from "../utils/idempotency";

type QrSendMode = OutletSettings["qr_send_mode"];

const MODES: { value: QrSendMode; title: string; description: string }[] = [
  {
    value: "DIRECT",
    title: "Gửi thẳng vào bếp",
    description: "Khách bấm gửi là món vào bếp ngay. Món sai thì nhân viên hủy như món đã gửi bếp.",
  },
  {
    value: "CONFIRM",
    title: "Chờ phục vụ xác nhận",
    description: "Món khách gọi nằm chờ; phục vụ xem lại rồi bấm Gửi bếp hoặc bỏ món.",
  },
];

/** Cài đặt vận hành của cửa hàng (quyền OUTLET_SETTINGS, mặc định quản lý). */
export function AdminSettingsPage() {
  const [settings, setSettings] = useState<OutletSettings | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<QrSendMode | null>(null);
  const [toast, setToast] = useState<FlashMessage | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setSettings(await getOutletSettings());
      setState("ready");
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      setState("error");
    }
  }, []);

  useEffect(() => {
    document.title = "Cài đặt cửa hàng · NOVA POS";
    void load();
  }, [load]);

  async function choose(mode: QrSendMode) {
    if (!settings || saving || settings.qr_send_mode === mode) return;
    setSaving(mode);
    try {
      setSettings(await updateOutletSettings({ qr_send_mode: mode }, createIdempotencyKey()));
      setToast({ message: mode === "DIRECT" ? "Món QR sẽ vào bếp ngay." : "Món QR sẽ chờ phục vụ xác nhận.", type: "success" });
    } catch (saveError) {
      setToast({ message: getErrorMessage(saveError), type: "error" });
    } finally {
      setSaving(null);
    }
  }

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Quản trị · Cửa hàng</p>
            <h1>Cài đặt cửa hàng</h1>
            <p>Thay đổi có hiệu lực ngay cho lần gọi món tiếp theo và được ghi vào nhật ký.</p>
          </div>
        </div>
        {state === "loading" ? <StateCard kind="loading" title="Đang tải cài đặt" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải cài đặt" message={error} onRetry={() => void load()} /> : null}
        {state === "ready" && settings ? (
          <section className="nova-settings-card" aria-labelledby="nova-qr-mode-title">
            <h2 id="nova-qr-mode-title">Món khách gọi qua QR</h2>
            <div className="nova-settings-options" role="radiogroup" aria-labelledby="nova-qr-mode-title">
              {MODES.map((mode) => {
                const active = settings.qr_send_mode === mode.value;
                return (
                  <label key={mode.value} className={`nova-settings-option${active ? " nova-settings-option--active" : ""}`} data-testid={`qr-mode-${mode.value}`}>
                    <input type="radio" name="qr-send-mode" value={mode.value} checked={active} disabled={saving !== null} onChange={() => void choose(mode.value)} />
                    <span>
                      <strong>{mode.title}{saving === mode.value ? " · đang lưu…" : ""}</strong>
                      <p>{mode.description}</p>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
