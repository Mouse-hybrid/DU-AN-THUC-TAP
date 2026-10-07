import { MOCK_ERROR_STORAGE_KEY } from "../config.js";
import { createMockTables, MOCK_OUTLET_ID, MOCK_STAFF_ID } from "./data.js";

const TABLES_STORAGE_KEY = "nova_mock_tables";

export class MockApiError extends Error {
  constructor(status, detail, kind = "http") {
    const message = typeof detail === "string"
      ? detail
      : detail?.map?.((item) => item.msg).filter(Boolean).join("; ") || "Mock API error";
    super(message);
    this.name = "MockApiError";
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

function readTables() {
  const raw = sessionStorage.getItem(TABLES_STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(TABLES_STORAGE_KEY);
    }
  }
  const tables = createMockTables();
  sessionStorage.setItem(TABLES_STORAGE_KEY, JSON.stringify(tables));
  return tables;
}

function writeTables(tables) {
  sessionStorage.setItem(TABLES_STORAGE_KEY, JSON.stringify(tables));
}

function getFailureMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get("mock_error") || sessionStorage.getItem(MOCK_ERROR_STORAGE_KEY) || "";
}

function throwConfiguredFailure(mode) {
  if (!mode || mode === "empty") return;
  if (mode === "network") {
    throw new MockApiError(0, "Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.", "network");
  }
  if (mode === "401") throw new MockApiError(401, "Thông tin đăng nhập không hợp lệ");
  if (mode === "403") throw new MockApiError(403, "Không đủ quyền thực hiện thao tác này");
  if (mode === "409") throw new MockApiError(409, "Bàn vừa được người khác mở. Vui lòng tải lại.");
  if (mode === "422") {
    throw new MockApiError(422, [{ loc: ["body", "guest_count"], msg: "Input should be greater than or equal to 1", type: "greater_than_equal" }]);
  }
  if (mode === "500") throw new MockApiError(500, "Lỗi hệ thống, vui lòng thử lại sau");
}

function mockRole() {
  const role = new URLSearchParams(window.location.search).get("mock_role")?.toUpperCase();
  return ["CASHIER", "WAITER", "KITCHEN", "SUPERVISOR"].includes(role) ? role : "CASHIER";
}

function tableIdFromPath(path) {
  return path.match(/^\/api\/v1\/tables\/([^/]+)\/open-session$/)?.[1] || null;
}

export async function mockRequest(path, { method, body }) {
  await new Promise((resolve) => window.setTimeout(resolve, 360));
  const failureMode = getFailureMode();
  throwConfiguredFailure(failureMode);

  if (path === "/api/v1/auth/login" && method === "POST") {
    if (!body?.username?.trim() || !body?.password) {
      throw new MockApiError(422, [{ loc: ["body"], msg: "Username and password are required", type: "missing" }]);
    }
    return {
      access_token: `mock.${crypto.randomUUID()}`,
      token_type: "bearer",
      expires_in_minutes: 480,
      staff: {
        id: MOCK_STAFF_ID,
        outlet_id: MOCK_OUTLET_ID,
        username: body.username.trim(),
        full_name: "Nhân viên NOVA",
        role: mockRole(),
      },
    };
  }

  if (path === "/api/v1/tables" && method === "GET") {
    return failureMode === "empty" ? [] : readTables();
  }

  const tableId = tableIdFromPath(path);
  if (tableId && method === "POST") {
    if (!Number.isInteger(body?.guest_count) || body.guest_count < 1 || body.guest_count > 100) {
      throw new MockApiError(422, [{ loc: ["body", "guest_count"], msg: "Input should be between 1 and 100", type: "value_error" }]);
    }

    const tables = readTables();
    const table = tables.find((item) => item.id === tableId);
    if (!table) throw new MockApiError(404, "Không tìm thấy bàn");
    if (!["AVAILABLE", "RESERVED"].includes(table.status)) {
      throw new MockApiError(409, `Bàn đang ở trạng thái '${table.status}', không thể mở phiên mới`);
    }

    const openedAt = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      table_id: table.id,
      status: "OPEN",
      guest_count: body.guest_count,
      opened_at: openedAt,
    };
    Object.assign(table, {
      status: "OCCUPIED",
      current_session_id: session.id,
      guest_count: session.guest_count,
      opened_at: openedAt,
    });
    writeTables(tables);
    return session;
  }

  throw new MockApiError(404, "Mock endpoint không tồn tại");
}
