/** Nhãn tiếng Việt cho nhật ký hệ thống. Giá trị lạ từ backend vẫn hiển thị nguyên mã để không mất thông tin. */

const ACTION_LABELS: Record<string, string> = {
  TABLE_SESSION_OPENED: "Mở bàn",
  TABLE_CLEANED: "Dọn bàn xong",
  ORDER_CREATED: "Tạo đơn",
  ORDER_ITEMS_ADDED: "Thêm món vào đơn",
  ORDER_ITEM_UPDATED: "Sửa món trong đơn",
  ORDER_ITEM_REMOVED_BEFORE_SEND: "Xóa món trước khi gửi bếp",
  ORDER_SENT_TO_KITCHEN: "Gửi đơn vào bếp",
  ORDER_ITEM_START_COOKING: "Bếp bắt đầu làm món",
  ORDER_ITEM_MARKED_READY: "Bếp báo xong món",
  ORDER_ITEM_PICKED_UP: "Lấy món từ bếp",
  ORDER_ITEM_SERVED: "Mang món ra bàn",
  ORDER_ITEM_VOIDED: "Hủy món",
  ORDER_ITEM_REFIRED: "Làm lại món",
  ORDER_BILLING_REQUESTED: "Yêu cầu thanh toán",
  ORDER_PAID: "Xác nhận thanh toán",
  ORDER_CLOSED: "Đóng đơn",
  MENU_CATEGORY_CREATED: "Tạo nhóm món",
  MENU_CATEGORY_UPDATED: "Sửa nhóm món",
  MENU_ITEM_CREATED: "Tạo món",
  MENU_ITEM_UPDATED: "Sửa món",
};

const ENTITY_LABELS: Record<string, string> = {
  order: "Đơn hàng",
  order_item: "Món trong đơn",
  restaurant_table: "Bàn",
  table_session: "Phiên bàn",
  menu_item: "Món",
  menu_category: "Nhóm món",
};

export type AuditGroupId = "all" | "order" | "table" | "menu";

export const AUDIT_GROUPS: ReadonlyArray<{ id: AuditGroupId; label: string; entityTypes: readonly string[] }> = [
  { id: "all", label: "Tất cả", entityTypes: [] },
  { id: "order", label: "Đơn hàng", entityTypes: ["order", "order_item"] },
  { id: "table", label: "Bàn", entityTypes: ["restaurant_table", "table_session"] },
  { id: "menu", label: "Thực đơn", entityTypes: ["menu_item", "menu_category"] },
];

export function auditGroupMatches(group: AuditGroupId, entityType: string): boolean {
  if (group === "all") return true;
  return AUDIT_GROUPS.find((item) => item.id === group)?.entityTypes.includes(entityType) ?? false;
}

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType;
}

const PAYLOAD_LABELS: Record<string, string> = {
  name: "Tên",
  price: "Giá",
  guest_count: "Số khách",
  items_added: "Số món thêm",
  items_sent: "Số món gửi bếp",
  quantity: "Số lượng",
  note: "Ghi chú",
  reason: "Lý do",
  kitchen_tickets_cancelled: "Phiếu bếp đã hủy",
  is_available: "Đang bán",
  sort_order: "Thứ tự",
  is_active: "Đang dùng",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "trống";
  if (typeof value === "boolean") return value ? "có" : "không";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "…";
}

function keyLabel(key: string): string {
  return PAYLOAD_LABELS[key] ?? key;
}

/** Tóm tắt payload thành các dòng ngắn; bỏ qua mã định danh vì đã có ở cột đối tượng. */
export function summarizePayload(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const lines: string[] = [];
  const before = payload.before;
  const after = payload.after;
  if (isRecord(before) && isRecord(after)) {
    for (const key of Object.keys(after)) {
      if (key.endsWith("_id")) continue;
      lines.push(`${keyLabel(key)}: ${scalar(before[key])} → ${scalar(after[key])}`);
    }
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key === "before" || key === "after" || key.endsWith("_id")) continue;
    if (value !== null && typeof value === "object") continue;
    if (key === "reason" && (value === null || value === "")) continue;
    lines.push(`${keyLabel(key)}: ${scalar(value)}`);
  }
  return lines;
}
