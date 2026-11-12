import { useMemo, useSyncExternalStore } from "react";
import { getMe } from "../api/staff";
import { getAuth, getCachedPermissions, saveCachedPermissions } from "./storage";

/**
 * Mã quyền của backend (backend/app/core/permissions.py). Màn hình ẩn/hiện nút theo các mã này,
 * không theo tên vai trò, vì quản lý có thể chỉnh quyền từng vai trò ở màn 94.
 */
export type PermissionCode =
  | "ORDER_WRITE"
  | "SEND_TO_KITCHEN"
  | "REQUEST_BILLING"
  | "PROCESS_PAYMENT"
  | "OVERRIDE"
  | "VIEW_KDS"
  | "KITCHEN_ACTION"
  | "SERVE_FOOD"
  | "TABLE_OPEN"
  | "TABLE_MARK_CLEAN"
  | "TABLE_LAYOUT_MANAGE"
  | "TABLE_TRANSFER"
  | "QR_SESSION_MANAGE"
  | "MENU_WRITE"
  | "AUDIT_READ"
  | "STAFF_MANAGE"
  | "CUSTOMER_ACCESS"
  | "REWARD_APPLY"
  | "LOYALTY_MANAGE"
  | "PAYMENT_REFUND";

interface Snapshot {
  /** Access token mà `permissions` thuộc về, để đổi tài khoản không dùng nhầm quyền cũ. */
  token: string | null;
  permissions: readonly string[] | null;
  /** Lần gọi /auth/me gần nhất bị lỗi. */
  failed: boolean;
}

let snapshot: Snapshot = { token: null, permissions: null, failed: false };
let inflight: { token: string; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

function sameList(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
}

/**
 * Gọi GET /auth/me và lưu danh sách quyền hiện tại. Gọi khi mở trang và khi gặp 403.
 * Nhiều lời gọi cùng lúc dùng chung một request.
 */
export function refreshPermissions(): Promise<void> {
  const auth = getAuth();
  if (!auth) return Promise.resolve();
  const token = auth.accessToken;
  if (inflight?.token === token) return inflight.promise;

  const promise = (async () => {
    try {
      const me = await getMe();
      // Đã đăng xuất hoặc đổi tài khoản trong lúc chờ thì bỏ kết quả.
      if (getAuth()?.accessToken !== token) return;
      saveCachedPermissions(token, me.permissions);
      if (snapshot.token === token && sameList(snapshot.permissions, me.permissions) && !snapshot.failed) return;
      publish({ token, permissions: me.permissions, failed: false });
    } catch {
      if (getAuth()?.accessToken !== token) return;
      const known = snapshot.token === token ? snapshot.permissions : getCachedPermissions(token);
      publish({ token, permissions: known, failed: true });
    } finally {
      if (inflight?.token === token) inflight = null;
    }
  })();
  inflight = { token, promise };
  return promise;
}

export interface PermissionsApi {
  /** Đã biết quyền của người đang đăng nhập (từ bản lưu hoặc từ /auth/me). */
  ready: boolean;
  /** Chưa biết quyền và lần gọi /auth/me gần nhất lỗi. */
  failed: boolean;
  can: (code: PermissionCode) => boolean;
  canAny: (codes: readonly PermissionCode[]) => boolean;
  refresh: () => Promise<void>;
}

export function usePermissions(): PermissionsApi {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  const token = getAuth()?.accessToken ?? null;

  return useMemo(() => {
    let list: readonly string[] | null = null;
    if (token) list = snap.token === token ? snap.permissions : getCachedPermissions(token);
    const granted = new Set(list ?? []);
    return {
      ready: list !== null,
      failed: list === null && snap.token === token && snap.failed,
      can: (code) => granted.has(code),
      canAny: (codes) => codes.some((code) => granted.has(code)),
      refresh: refreshPermissions,
    };
  }, [snap, token]);
}
