import { apiRequest, createIdempotencyKey, getApiErrorMessage } from "../api.js";
import { getAuth, getPostLoginUrl, saveAuth } from "../auth.js";
import { consumeFlash, initOfflineBanner, setAlert, setButtonPending, showToast } from "../ui.js";

const form = document.querySelector("#nova-login-form");
const usernameInput = document.querySelector("#nova-username");
const passwordInput = document.querySelector("#nova-password");
const usernameError = document.querySelector("#nova-username-error");
const passwordError = document.querySelector("#nova-password-error");
const submitButton = document.querySelector("#nova-login-submit");
const alert = document.querySelector("#nova-login-alert");
const togglePasswordButton = document.querySelector("#nova-toggle-password");

initOfflineBanner();

const flash = consumeFlash();
if (flash) showToast(flash.message, flash.type);

const existingAuth = getAuth();
if (existingAuth) window.location.replace(getPostLoginUrl(existingAuth.staff?.role));

function setFieldError(input, errorElement, invalid) {
  input.setAttribute("aria-invalid", String(invalid));
  errorElement.hidden = !invalid;
}

function validate() {
  const usernameMissing = !usernameInput.value.trim();
  const passwordMissing = !passwordInput.value;
  setFieldError(usernameInput, usernameError, usernameMissing);
  setFieldError(passwordInput, passwordError, passwordMissing);
  return !usernameMissing && !passwordMissing;
}

togglePasswordButton.addEventListener("click", () => {
  const isVisible = passwordInput.type === "text";
  passwordInput.type = isVisible ? "password" : "text";
  togglePasswordButton.setAttribute("aria-label", isVisible ? "Hiện mã PIN" : "Ẩn mã PIN");
  togglePasswordButton.setAttribute("aria-pressed", String(!isVisible));
  togglePasswordButton.querySelector("use").setAttribute("href", `assets/icons/lucide-sprite.svg#${isVisible ? "eye" : "eye-off"}`);
});

usernameInput.addEventListener("input", () => setFieldError(usernameInput, usernameError, false));
passwordInput.addEventListener("input", () => setFieldError(passwordInput, passwordError, false));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAlert(alert);
  if (!validate()) return;

  const idempotencyKey = createIdempotencyKey();
  let failed = false;
  setButtonPending(submitButton, true, "Đang đăng nhập…");
  usernameInput.disabled = true;
  passwordInput.disabled = true;

  try {
    const tokenResponse = await apiRequest("/api/v1/auth/login", {
      method: "POST",
      body: { username: usernameInput.value.trim(), password: passwordInput.value },
      requiresAuth: false,
      idempotencyKey,
    });
    const auth = saveAuth(tokenResponse);
    window.location.replace(getPostLoginUrl(auth.staff?.role));
  } catch (error) {
    failed = true;
    setAlert(alert, getApiErrorMessage(error));
  } finally {
    setButtonPending(submitButton, false);
    if (failed) submitButton.querySelector(".nova-button-label").textContent = "Thử lại";
    usernameInput.disabled = false;
    passwordInput.disabled = false;
  }
});
