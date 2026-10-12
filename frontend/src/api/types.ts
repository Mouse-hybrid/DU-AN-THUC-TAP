import type { components, paths } from "./schema";

export type LoginRequest = components["schemas"]["LoginRequest"];
export type TokenResponse = components["schemas"]["TokenResponse"];
export type StaffOut = components["schemas"]["StaffOut"];
export type TableDashboardItem = components["schemas"]["TableDashboardItem"];
export type OpenSessionRequest = components["schemas"]["OpenSessionRequest"];
export type TableSessionOut = components["schemas"]["TableSessionOut"];
export type ValidationError = components["schemas"]["ValidationError"];

export type LoginResponse = paths["/api/v1/auth/login"]["post"]["responses"][200]["content"]["application/json"];
export type TableDashboardResponse = paths["/api/v1/tables"]["get"]["responses"][200]["content"]["application/json"];
export type OpenSessionResponse = paths["/api/v1/tables/{table_id}/open-session"]["post"]["responses"][201]["content"]["application/json"];
