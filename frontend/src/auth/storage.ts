import type { StaffOut, TokenResponse } from "../api/types";

const AUTH_KEY = "pos_auth";
const PERMISSIONS_KEY = "pos_permissions";
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

/** Cập nhật họ tên đang lưu khi quản lý tự sửa tên mình, để thanh trên cùng không hiển thị tên cũ. */
export function updateStoredFullName(fullName: string): void {
  const auth = getAuth();
  if (!auth) return;
  localStorage.setItem(AUTH_KEY, JSON.stringify({ ...auth, staff: { ...auth.staff, full_name: fullName } }));
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(PERMISSIONS_KEY);
}

/**
 * Bản sao quyền lấy từ GET /auth/me, gắn với access token để phiên đăng nhập khác không dùng nhầm.
 * Chỉ để màn hình không nhấp nháy khi mở trang; nguồn đúng vẫn là backend và luôn được gọi lại.
 */
export function getCachedPermissions(accessToken: string): string[] | null {
  try {
    const raw = localStorage.getItem(PERMISSIONS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.token !== accessToken ||
      !Array.isArray(parsed.permissions) ||
      !parsed.permissions.every((code) => typeof code === "string")
    ) {
      return null;
    }
    return parsed.permissions as string[];
  } catch {
    return null;
  }
}

export function saveCachedPermissions(accessToken: string, permissions: readonly string[]): void {
  try {
    localStorage.setItem(PERMISSIONS_KEY, JSON.stringify({ token: accessToken, permissions }));
  } catch {
    // Bộ nhớ trình duyệt đầy hoặc bị chặn: bỏ qua, lần mở trang sau vẫn gọi lại /auth/me.
  }
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
  window.location.assign(window.location.pathname.startsWith("/kitchen") ? "/login?area=kitchen" : "/login");
  throw new Error("AUTH_REDIRECT");
}
