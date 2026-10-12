import type { components } from "../api/schema";

export type StaffRole = components["schemas"]["StaffOut"]["role"];

export function hasRole(
  role: StaffRole | null | undefined,
  allow: readonly StaffRole[],
): boolean {
  return role !== null && role !== undefined && allow.includes(role);
}
