import type { OrderDetail } from "../api/orders";

const CLOSED_ORDER_STATUSES = new Set(["BILLING", "PAID", "CLOSED"]);

function latestOrder(orders: OrderDetail[]): OrderDetail | null {
  return orders.reduce<OrderDetail | null>((latest, candidate) => {
    if (!latest) return candidate;
    const latestTime = Date.parse(latest.created_at);
    const candidateTime = Date.parse(candidate.created_at);
    if (!Number.isFinite(latestTime)) return candidate;
    if (!Number.isFinite(candidateTime)) return latest;
    return candidateTime >= latestTime ? candidate : latest;
  }, null);
}

export function isClosedOrderStatus(status: string): boolean {
  return CLOSED_ORDER_STATUSES.has(status);
}

export function countOpenOrders(orders: OrderDetail[]): number {
  return orders.filter((order) => !isClosedOrderStatus(order.status)).length;
}

export function selectCurrentOrder(orders: OrderDetail[]): OrderDetail | null {
  const openOrders = orders.filter((order) => !isClosedOrderStatus(order.status));
  return latestOrder(openOrders) ?? latestOrder(orders.filter((order) => order.status === "BILLING"));
}
