import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { changePassword, getMe, type MeInfo } from "../api/staff";
import { saveAuth, type FlashMessage } from "../auth/storage";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { PasswordField } from "../components/PasswordField";
import { StateCard } from "../components/StateCard";
import { Toast } from "../components/Toast";
import { staffErrorMessage } from "../utils/errorMessages";
import { createIdempotencyKey } from "../utils/idempotency";
import { validateNewPassword } from "../utils/password";
import { initialsOf, roleLabel } from "../utils/roleLabels";

export function ProfilePage() {
  const [me, setMe] = useState<MeInfo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState<FlashMessage | null>(null);
  const running = useRef(false);

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setMe(await getMe());
      setState("ready");
    } catch (loadError) {
      setError(staffErrorMessage(loadError, "Dữ liệu vừa thay đổi. Vui lòng tải lại."));
      setState("error");
    }
  }, []);

  useEffect(() => {
    document.title = "Hồ sơ của tôi · NOVA POS";
    void load();
  }, [load]);

  const errors = {
    current: currentPassword ? "" : "Vui lòng nhập mật khẩu hiện tại.",
    next: validateNewPassword(newPassword) || (newPassword === currentPassword ? "Mật khẩu mới phải khác mật khẩu hiện tại." : ""),
    confirm: confirmPassword === newPassword ? "" : "Mật khẩu nhập lại chưa khớp.",
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current) return;
    setSubmitted(true);
    setFormError("");
    if (errors.current || errors.next || errors.confirm) return;
    running.current = true;
    setBusy(true);
    try {
      const response = await changePassword({ current_password: currentPassword, new_password: newPassword }, createIdempotencyKey());
      // Backend thu hồi các phiên cũ và cấp token mới: phải lưu lại, nếu không lần gọi tiếp theo sẽ bị 401.
      saveAuth(response);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSubmitted(false);
      setToast({ message: "Đã đổi mật khẩu. Các thiết bị khác cần đăng nhập lại.", type: "success" });
    } catch (submitError) {
      setFormError(staffErrorMessage(submitError, "Không đổi được mật khẩu lúc này. Vui lòng thử lại."));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <main className="nova-content">
        <div className="nova-page-toolbar">
          <div className="nova-page-heading">
            <p className="nova-eyebrow">Tài khoản</p>
            <h1>Hồ sơ của tôi</h1>
            <p>Xem thông tin tài khoản và đổi mật khẩu đăng nhập.</p>
          </div>
        </div>

        {state === "loading" ? <StateCard kind="loading" title="Đang tải hồ sơ" message="Vui lòng chờ trong giây lát." /> : null}
        {state === "error" ? <StateCard kind="error" title="Không thể tải hồ sơ" message={error} onRetry={() => void load()} /> : null}

        {state === "ready" && me ? (
          <div className="nova-profile-layout">
            <section className="nova-profile-card" aria-labelledby="nova-profile-info-title">
              <div className="nova-profile-head">
                <span className="nova-user-avatar nova-profile-avatar" aria-hidden="true">{initialsOf(me.full_name)}</span>
                <div>
                  <h2 id="nova-profile-info-title">{me.full_name}</h2>
                  <span className="nova-entity-pill">{roleLabel(me.role)}</span>
                </div>
              </div>
              <dl className="nova-profile-list">
                <div><dt>Tên đăng nhập</dt><dd>{me.username}</dd></div>
                <div><dt>Vai trò</dt><dd>{roleLabel(me.role)}</dd></div>
                <div><dt>Số quyền được cấp</dt><dd>{me.permissions.length}</dd></div>
              </dl>
              {me.permissions.length > 0 ? (
                <details className="nova-profile-permissions">
                  <summary>Xem mã quyền ({me.permissions.length})</summary>
                  <ul>{me.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul>
                </details>
              ) : null}
              <p className="nova-readonly-note">Muốn đổi họ tên hoặc vai trò, hãy nhờ quản lý. Ảnh đại diện, số điện thoại và email chờ backend bổ sung.</p>
            </section>

            <form className="nova-profile-card" aria-labelledby="nova-profile-password-title" onSubmit={(event) => void submit(event)} noValidate>
              <h2 id="nova-profile-password-title">Đổi mật khẩu</h2>
              <PasswordField id="nova-current-password" label="Mật khẩu hiện tại" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" disabled={busy} {...(submitted && errors.current ? { error: errors.current } : {})} />
              <PasswordField id="nova-new-password" label="Mật khẩu mới" value={newPassword} onChange={setNewPassword} autoComplete="new-password" disabled={busy} {...(submitted && errors.next ? { error: errors.next } : { hint: "Tối thiểu 8 ký tự." })} />
              <PasswordField id="nova-confirm-password" label="Nhập lại mật khẩu mới" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" disabled={busy} {...(submitted && errors.confirm ? { error: errors.confirm } : {})} />
              {formError ? <div className="nova-alert" role="alert">{formError}</div> : null}
              <Button variant="primary" type="submit" accessibleLabel="Đổi mật khẩu" busy={busy}>Đổi mật khẩu</Button>
              <p className="nova-readonly-note">Sau khi đổi, các thiết bị khác đang đăng nhập bằng tài khoản này sẽ bị đăng xuất.</p>
            </form>
          </div>
        ) : null}
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}
