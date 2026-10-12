import { getAuth, redirectToLogin } from "../auth/storage";

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
export const API_BASE_URL = (configuredBaseUrl || "/api/v1").replace(/\/+$/, "");

const MUTATION_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const REQUEST_TIMEOUT_MS = 12_000;

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface RequestOptions<TBody> {
  method?: HttpMethod;
  body?: TBody;
  auth?: boolean;
  idempotencyKey?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    username: "Mã nhân viên",
    password: "Mã PIN",
    guest_count: "Số khách",
    table_id: "Bàn",
  };
  return labels[field] ?? field;
}

function validationMessage(message: string): string {
  const normalized = message.trim();
  if (normalized === "Field required") return "không được để trống";
  if (normalized === "Input should be a valid integer") return "phải là số nguyên hợp lệ";
  if (normalized.includes("greater than or equal to 1")) return "phải lớn hơn hoặc bằng 1";
  if (normalized.includes("less than or equal to 100")) return "phải nhỏ hơn hoặc bằng 100";
  return normalized;
}

function parseValidationDetail(detail: unknown[]): string {
  const messages = detail.flatMap((item) => {
    if (!isRecord(item) || typeof item.msg !== "string") return [];
    const loc = Array.isArray(item.loc) ? item.loc : [];
    const field = [...loc].reverse().find((part): part is string => typeof part === "string" && part !== "body");
    const message = validationMessage(item.msg);
    return field ? [`${fieldLabel(field)}: ${message}`] : [message];
  });
  return messages.length > 0 ? messages.join(". ") : "Dữ liệu gửi lên chưa hợp lệ.";
}

function errorMessage(payload: unknown, status: number): string {
  if (status === 401) return "Mã nhân viên hoặc mã PIN không đúng.";
  if (status === 403) return "Bạn không có quyền thực hiện thao tác này.";
  if (status === 409) return "Dữ liệu đã thay đổi hoặc thao tác bị trùng. Vui lòng tải lại.";
  if (status >= 500) return "Máy chủ đang gặp sự cố. Vui lòng thử lại sau.";

  if (isRecord(payload)) {
    if (Array.isArray(payload.detail)) return parseValidationDetail(payload.detail);
    if (typeof payload.detail === "string" && payload.detail.trim()) return payload.detail;
  }

  if (status === 422) return "Dữ liệu gửi lên chưa hợp lệ.";
  return "Không thể hoàn tất yêu cầu. Vui lòng thử lại.";
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function fetchOnce<TResponse, TBody>(path: string, options: RequestOptions<TBody>): Promise<TResponse> {
  if (!navigator.onLine) throw new ApiError("Đang ngoại tuyến. Vui lòng kiểm tra kết nối mạng.", 0);

  const method = options.method ?? "GET";
  const needsAuth = options.auth !== false;
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  if (needsAuth) {
    const auth = getAuth();
    if (!auth) redirectToLogin();
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
  }

  if (MUTATION_METHODS.has(method)) {
    if (!options.idempotencyKey) throw new Error("Mutation request requires an Idempotency-Key");
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const requestInit: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);
    const response = await fetch(`${API_BASE_URL}${path}`, requestInit);
    const payload = await readPayload(response);
    if (!response.ok) {
      if (response.status === 401 && needsAuth) redirectToLogin();
      throw new ApiError(errorMessage(payload, response.status), response.status);
    }
    return payload as TResponse;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function apiRequest<TResponse, TBody = never>(
  path: string,
  options: RequestOptions<TBody> = {},
): Promise<TResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchOnce<TResponse, TBody>(path, options);
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof ApiError) || error.status === 0;
      if (!retryable || attempt === 1 || !navigator.onLine) break;
    }
  }

  if (lastError instanceof ApiError) throw lastError;
  if (lastError instanceof DOMException && lastError.name === "AbortError") {
    throw new ApiError("Máy chủ phản hồi quá chậm. Vui lòng thử lại.", 0);
  }
  throw new ApiError("Không thể kết nối máy chủ. Vui lòng thử lại.", 0);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Đã có lỗi xảy ra. Vui lòng thử lại.";
}
