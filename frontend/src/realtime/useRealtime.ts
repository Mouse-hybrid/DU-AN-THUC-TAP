import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../api/client";
import { getAuth } from "../auth/storage";

// Kênh và sự kiện: docs/api/api-catalog.md mục A (bảng event WebSocket).
export type RealtimeChannel = "tables" | "kitchen";

export interface RealtimeEvent {
  type: string;
  channel: RealtimeChannel;
  data: Record<string, unknown>;
  at: string;
}

interface UseRealtimeOptions {
  channel: RealtimeChannel;
  /** Gọi (đã gộp các sự kiện dồn dập) khi có sự kiện liên quan hoặc vừa kết nối lại. */
  onRefresh: () => void;
  /** Bỏ qua sự kiện không liên quan tới màn hiện tại (vd bàn khác). */
  filter?: (event: RealtimeEvent) => boolean;
}

const PING_INTERVAL_MS = 25_000;
const REFRESH_DEBOUNCE_MS = 300;
const MAX_RECONNECT_DELAY_MS = 15_000;

function buildSocketUrl(channel: RealtimeChannel, token: string): string {
  // API_BASE_URL có thể là đường dẫn tương đối (/api/v1, cùng origin qua nginx)
  // hoặc URL đầy đủ khi FE chạy local trỏ vào staging.
  const url = new URL(`${API_BASE_URL}/ws`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("channel", channel);
  return url.toString();
}

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Nghe WebSocket realtime và gọi `onRefresh` để màn tự tải lại qua REST.
 * Polling của từng màn vẫn giữ làm dự phòng: hàm trả về `connected` để màn
 * giãn chu kỳ polling khi WebSocket đang chạy. Lỗi kết nối không bao giờ làm
 * hỏng màn — chỉ quay về polling và tự kết nối lại.
 */
export function useRealtime({ channel, onRefresh, filter }: UseRealtimeOptions): boolean {
  const [connected, setConnected] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  const filterRef = useRef(filter);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
    filterRef.current = filter;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let disposed = false;
    let attempts = 0;
    let hasOpened = false;
    let pendingWhileHidden = false;
    let pingTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let refreshTimer: number | undefined;

    function scheduleRefresh() {
      if (document.visibilityState !== "visible") {
        pendingWhileHidden = true;
        return;
      }
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => onRefreshRef.current(), REFRESH_DEBOUNCE_MS);
    }

    function handleVisibility() {
      if (document.visibilityState === "visible" && pendingWhileHidden) {
        pendingWhileHidden = false;
        scheduleRefresh();
      }
    }

    function scheduleReconnect() {
      if (disposed) return;
      const delay = Math.min(1_000 * 2 ** attempts, MAX_RECONNECT_DELAY_MS);
      attempts += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    }

    function connect() {
      if (disposed) return;
      const auth = getAuth();
      if (!auth) return; // Hết phiên: ProtectedRoute sẽ đưa về màn đăng nhập.

      try {
        socket = new WebSocket(buildSocketUrl(channel, auth.accessToken));
      } catch {
        scheduleReconnect();
        return;
      }

      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, PING_INTERVAL_MS);
        // Kết nối lại sau khi rớt: có thể đã lỡ sự kiện nên tải lại một lần.
        if (hasOpened) scheduleRefresh();
        hasOpened = true;
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!isRealtimeEvent(parsed) || parsed.type === "pong") return;
        const event = { ...parsed, data: parsed.data ?? {} };
        if (filterRef.current && !filterRef.current(event)) return;
        scheduleRefresh();
      };

      socket.onclose = () => {
        window.clearInterval(pingTimer);
        socket = null;
        setConnected(false);
        scheduleReconnect();
      };
    }

    connect();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(pingTimer);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(refreshTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      setConnected(false);
    };
  }, [channel]);

  return connected;
}
