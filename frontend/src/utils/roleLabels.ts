import type { StaffRoleCode } from "../api/staff";

export const ROLE_LABELS: Record<string, string> = {
  SUPERVISOR: "Quản lý",
  CASHIER: "Thu ngân",
  WAITER: "Phục vụ",
  KITCHEN: "Bếp",
};

/** Thứ tự hiển thị cố định ở mọi màn (quản lý → thu ngân → phục vụ → bếp). */
export const ROLE_ORDER = ["SUPERVISOR", "CASHIER", "WAITER", "KITCHEN"] as const satisfies readonly StaffRoleCode[];

export function roleLabel(role: string | null | undefined): string {
  return ROLE_LABELS[role ?? ""] ?? role ?? "";
}

export function initialsOf(fullName: string | undefined): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";
  return (words.length === 1 ? first.slice(0, 2) : `${first.charAt(0)}${last.charAt(0)}`).toUpperCase();
}
