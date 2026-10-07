import { API_BASE_URL, API_TIMEOUT_MS, USE_MOCK } from "./config.js";
import { getAuth, redirectToLogin } from "./auth.js";
import { MockApiError, mockRequest } from "./mock/client.js";

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null, kind = "http" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

export function createIdempotencyKey() {
  return crypto.randomUUID();
}

function parseDetail(payload) {
  const detail = payload?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => item?.msg).filter(Boolean).join("; ") || "Dữ liệu chưa hợp lệ.";
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return "Yêu cầu không thể hoàn tất.";
}

function normalizeError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof MockApiError) {
    return new ApiError(error.message, {
      status: error.status,
      detail: error.detail,
      kind: error.kind,
    });
  }
  if (error?.name === "AbortError") {
    return new ApiError("Yêu cầu mất quá nhiều thời gian. Vui lòng thử lại.", { kind: "timeout" });
  }
  return new ApiError("Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.", { kind: "network" });
}

async function executeFetch(path, { method, body, requiresAuth, idempotencyKey }) {
  if (!navigator.onLine) {
    throw new ApiError("Thiết bị đang ngoại tuyến. Vui lòng kiểm tra kết nối mạng.", { kind: "network" });
  }

  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  if (requiresAuth) {
    const auth = getAuth();
    if (!auth) {
      redirectToLogin();
      throw new ApiError("Phiên đăng nhập đã hết hạn.", { status: 401, kind: "auth" });
    }
    headers.Authorization = `Bearer ${auth.access_token}`;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    let payload = null;
    const responseText = await response.text();
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new ApiError(parseDetail(payload), { status: response.status, detail: payload?.detail });
    }
    return payload;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function execute(path, options) {
  if (USE_MOCK) return mockRequest(path, options);
  return executeFetch(path, options);
}

export async function apiRequest(path, options = {}) {
  if (!path.startsWith("/api/v1/")) {
    throw new Error("API path phải bắt đầu bằng /api/v1/.");
  }

  const method = (options.method || "GET").toUpperCase();
  const isMutation = ["POST", "PATCH", "DELETE"].includes(method);
  if (isMutation && !options.idempotencyKey) {
    throw new Error("Yêu cầu ghi dữ liệu phải có Idempotency-Key tạo tại thao tác người dùng.");
  }

  const requestOptions = {
    method,
    body: options.body,
    requiresAuth: options.requiresAuth !== false,
    idempotencyKey: options.idempotencyKey,
  };

  const maxAttempts = isMutation ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await execute(path, requestOptions);
    } catch (error) {
      lastError = normalizeError(error);
      const canRetry = ["network", "timeout"].includes(lastError.kind) && attempt < maxAttempts;
      if (!canRetry) break;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }

  if (lastError.status === 401 && requestOptions.requiresAuth) {
    redirectToLogin();
  }
  throw lastError;
}

export function getApiErrorMessage(error) {
  if (!(error instanceof ApiError)) return "Đã có lỗi xảy ra. Vui lòng thử lại.";
  if (["network", "timeout"].includes(error.kind)) return error.message;
  if (error.status === 401) return "Mã nhân viên hoặc mã PIN không đúng.";
  if (error.status === 403) return "Bạn không có quyền thực hiện thao tác này.";
  if (error.status === 409) return error.message || "Dữ liệu đã thay đổi. Vui lòng tải lại và thử lại.";
  if (error.status === 422) return error.message || "Dữ liệu chưa hợp lệ. Vui lòng kiểm tra lại.";
  if (error.status >= 500) return error.message || "Lỗi hệ thống, vui lòng thử lại sau.";
  return error.message || "Yêu cầu không thể hoàn tất.";
}
