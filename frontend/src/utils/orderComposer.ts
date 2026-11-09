import { ApiError } from "../api/client";
import { addItems, createOrder, getOrder, updateItem, type OrderDetail } from "../api/orders";
import type { components } from "../api/schema";
import type { TableDetailResponse } from "../api/tables";
import { createIdempotencyKey } from "./idempotency";
import { countOpenOrders, isClosedOrderStatus, selectCurrentOrder } from "./orders";

type MenuItem = components["schemas"]["MenuItemOut"];

export interface TableOrderView {
  /** Đơn đang mở mới nhất của bàn (hoặc đơn BILLING để xem), null nếu chưa có. */
  order: OrderDetail | null;
  /** Bàn chỉ còn đơn đã đóng: chỉ được xem. */
  closedOnly: boolean;
  multipleOpenOrders: boolean;
  /** Không được thêm món (đơn BILLING/PAID/CLOSED). */
  readOnly: boolean;
}

/** Logic chọn đơn dùng chung cho màn Gọi món (09) và Tìm món nhanh (12). */
export function resolveTableOrder(table: TableDetailResponse): TableOrderView {
  if (!table.current_session && table.orders.length === 0) {
    throw new ApiError("Bàn chưa có phiên phục vụ hoặc đơn để hiển thị.", 409);
  }
  const openOrderCount = countOpenOrders(table.orders);
  const order = selectCurrentOrder(table.orders);
  const closedOnly = openOrderCount === 0 && table.orders.length > 0;
  return {
    order,
    closedOnly,
    multipleOpenOrders: openOrderCount > 1,
    readOnly: closedOnly || Boolean(order && isClosedOrderStatus(order.status)),
  };
}

interface AddMenuItemParams {
  table: TableDetailResponse;
  order: OrderDetail | null;
  item: MenuItem;
  /** Tùy chọn (size/topping) đã chọn; có tùy chọn thì luôn tạo dòng riêng. */
  modifierOptionIds?: string[];
  /** Gọi ngay sau khi đơn mới được tạo để màn hình không tạo đơn thứ hai nếu bước thêm món lỗi. */
  onOrderCreated?: (order: OrderDetail) => void;
}

/**
 * Thêm 1 phần món vào đơn đang mở của bàn; tạo đơn ở lần thêm đầu tiên.
 * Nếu đơn đã có dòng cùng món, chưa gửi bếp (CREATED) và không có ghi chú thì tăng số lượng dòng đó
 * (PATCH quantity) thay vì tạo thêm một dòng mới.
 * Mỗi lần ghi dùng một Idempotency-Key riêng; luôn tải lại GET /orders/{id} sau khi ghi.
 */
export async function addMenuItemToOrder({ table, order, item, modifierOptionIds = [], onOrderCreated }: AddMenuItemParams): Promise<OrderDetail> {
  if (!navigator.onLine) throw new ApiError("Bạn đang ngoại tuyến. Thao tác chưa được gửi.", 0);
  if (!table.current_session) throw new ApiError("Bàn chưa có phiên phục vụ đang mở.", 409);

  const sameLine = modifierOptionIds.length > 0 ? undefined : order?.items.find(
    (line) => line.menu_item_id === item.id
      && line.status === "CREATED"
      && !(line.note ?? "").trim()
      && (line.modifiers ?? []).length === 0,
  );
  if (order && sameLine) {
    await updateItem(order.id, sameLine.id, { quantity: sameLine.quantity + 1 }, createIdempotencyKey());
    return getOrder(order.id);
  }

  let orderId = order?.id;
  if (!orderId) {
    const created = await createOrder({ table_session_id: table.current_session.id }, createIdempotencyKey());
    orderId = created.id;
    onOrderCreated?.(await getOrder(orderId));
  }

  const line = modifierOptionIds.length > 0
    ? { menu_item_id: item.id, quantity: 1, note: null, modifier_option_ids: modifierOptionIds }
    : { menu_item_id: item.id, quantity: 1, note: null };
  await addItems(orderId, { items: [line] }, createIdempotencyKey());
  return getOrder(orderId);
}
