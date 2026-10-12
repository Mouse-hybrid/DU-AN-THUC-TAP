import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { apiRequest, getErrorMessage } from "../api/client";
import type { LoginRequest, LoginResponse } from "../api/types";
import { consumeFlash, getAuth, getHomePath, saveAuth, type FlashMessage } from "../auth/storage";
import { Icon } from "../components/Icon";
import { Toast } from "../components/Toast";
import { createIdempotencyKey } from "../utils/idempotency";

export function LoginPage() {
  const navigate = useNavigate();
  const existingAuth = getAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [toast, setToast] = useState<FlashMessage | null>(() => consumeFlash());

  if (existingAuth) return <Navigate to={getHomePath(existingAuth.staff.role)} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setAlert("");
    const cleanUsername = username.trim();
    if (!cleanUsername || !password) return;
    if (!navigator.onLine) {
      setAlert("Đang ngoại tuyến. Vui lòng kiểm tra kết nối mạng.");
      return;
    }

    setBusy(true);
    const body: LoginRequest = { username: cleanUsername, password };
    try {
      const idempotencyKey = createIdempotencyKey();
      const response = await apiRequest<LoginResponse, LoginRequest>("/auth/login", {
        method: "POST",
        body,
        auth: false,
        idempotencyKey,
      });
      const auth = saveAuth(response);
      navigate(getHomePath(auth.staff.role), { replace: true });
    } catch (error) {
      setAlert(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <main className="nova-login-shell">
        <section className="nova-login-brand" aria-label="NOVA POS">
          <div className="nova-brand-lockup">
            <span className="nova-brand-mark nova-brand-mark--large" aria-hidden="true">N</span>
            <span>NOVA POS</span>
          </div>
          <div>
            <p className="nova-eyebrow">Hệ thống bán hàng</p>
            <h1>Vận hành nhà hàng<br />nhẹ nhàng hơn.</h1>
            <p className="nova-login-copy">Đăng nhập để quản lý bàn và phục vụ khách hàng.</p>
          </div>
          <p className="nova-login-meta">Đồng bộ bảo mật · Phiên bản thử nghiệm</p>
        </section>

        <section className="nova-login-panel">
          <form className="nova-login-form" noValidate onSubmit={handleSubmit}>
            <header className="nova-page-heading">
              <p className="nova-eyebrow">Đăng nhập bằng mã nhân viên</p>
              <h2>Chào mừng trở lại</h2>
              <p>Nhập thông tin được cấp để bắt đầu ca làm việc.</p>
            </header>

            {alert ? <div className="nova-alert" role="alert">{alert}</div> : null}

            <div className="nova-field">
              <label htmlFor="nova-username">Mã nhân viên</label>
              <input
                id="nova-username"
                name="username"
                type="text"
                autoComplete="username"
                placeholder="Ví dụ: NV-2048"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                aria-invalid={submitted && !username.trim()}
                disabled={busy}
              />
              {submitted && !username.trim() ? <p className="nova-field-error">Vui lòng nhập mã nhân viên.</p> : null}
            </div>

            <div className="nova-field">
              <label htmlFor="nova-password">Mã PIN</label>
              <div className="nova-password-wrap">
                <input
                  id="nova-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  inputMode="numeric"
                  autoComplete="current-password"
                  placeholder="Nhập mã PIN"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={submitted && !password}
                  disabled={busy}
                />
                <button
                  className="nova-icon-button"
                  type="button"
                  aria-label={showPassword ? "Ẩn mã PIN" : "Hiện mã PIN"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                  disabled={busy}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} />
                </button>
              </div>
              {submitted && !password ? <p className="nova-field-error">Vui lòng nhập mã PIN.</p> : null}
            </div>

            <button className="nova-button nova-button--primary nova-button--full" type="submit" disabled={busy}>
              {busy ? <span className="nova-spinner" aria-hidden="true" /> : null}
              <span>{busy ? "Đang đăng nhập…" : "Đăng nhập"}</span>
            </button>
          </form>
        </section>
      </main>
      {toast ? <Toast {...toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
