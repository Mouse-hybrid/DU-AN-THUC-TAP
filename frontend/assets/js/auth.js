import { AUTH_STORAGE_KEY, FLASH_STORAGE_KEY } from "./config.js";

export function saveAuth(tokenResponse) {
  const expiresInMinutes = Number(tokenResponse.expires_in_minutes);
  const auth = {
    access_token: tokenResponse.access_token,
    token_type: tokenResponse.token_type || "bearer",
    staff: tokenResponse.staff,
    expires_at: Date.now() + expiresInMinutes * 60_000,
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  return auth;
}

export function getAuth() {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    const auth = JSON.parse(raw);
    if (!auth.access_token || !auth.expires_at || Date.now() >= Number(auth.expires_at)) {
      clearAuth();
      return null;
    }
    return auth;
  } catch {
    clearAuth();
    return null;
  }
}

export function clearAuth() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function requireAuth() {
  const auth = getAuth();
  if (!auth) {
    window.location.replace("login.html");
    return null;
  }
  return auth;
}

export function getPostLoginUrl(role) {
  return role === "KITCHEN" ? "kitchen.html" : "tables.html";
}

export function redirectToLogin(message = "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.") {
  clearAuth();
  sessionStorage.setItem(FLASH_STORAGE_KEY, JSON.stringify({ message, type: "error" }));
  window.location.replace("login.html");
}

export function logout() {
  clearAuth();
  window.location.replace("login.html");
}
