import type { StaffOut, TokenResponse } from "../api/types";

const AUTH_KEY = "pos_auth";
const FLASH_KEY = "nova_flash";

export interface StoredAuth {
  accessToken: TokenResponse["access_token"];
  expiresAt: number;
  staff: StaffOut;
}

export interface FlashMessage {
  message: string;
  type: "success" | "error" | "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function saveAuth(response: TokenResponse): StoredAuth {
  const auth: StoredAuth = {
    accessToken: response.access_token,
    expiresAt: Date.now() + response.expires_in_minutes * 60_000,
    staff: response.staff,
  };
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  return auth;
}

export function getAuth(): StoredAuth | null {
  const raw = localStorage.getItem(AUTH_KEY);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      !isRecord(parsed.staff) ||
      typeof parsed.staff.role !== "string"
    ) {
      clearAuth();
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      clearAuth();
      return null;
    }
    return parsed as unknown as StoredAuth;
  } catch {
    clearAuth();
    return null;
  }
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}

export function getHomePath(role: string): "/kitchen" | "/tables" {
  return role === "KITCHEN" ? "/kitchen" : "/tables";
}

export function setFlash(message: string, type: FlashMessage["type"] = "info"): void {
  sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, type } satisfies FlashMessage));
}

export function consumeFlash(): FlashMessage | null {
  const raw = sessionStorage.getItem(FLASH_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(FLASH_KEY);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.message !== "string") return null;
    const type = parsed.type;
    if (type !== "success" && type !== "error" && type !== "info") return null;
    return { message: parsed.message, type };
  } catch {
    return null;
  }
}

export function redirectToLogin(message = "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."): never {
  clearAuth();
  setFlash(message, "error");
  window.location.assign("/login");
  throw new Error("AUTH_REDIRECT");
}
