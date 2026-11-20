import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useRealtime, type RealtimeEvent } from "../realtime/useRealtime";

/**
 * Báo "món sẵn sàng" cho phục vụ ở mọi màn: nghe ORDER_UPDATED (reason ITEM_READY) trên kênh
 * `tables`, hiện thẻ nổi "Bàn B5: 1× Phở bò sẵn sàng" (bấm để mở bàn) và phát tiếng báo nếu bật.
 * Âm báo bật/tắt theo từng máy (localStorage).
 */

interface ReadyNotice {
  id: string;
  tableId: string;
  title: string;
  detail: string;
}

const SOUND_KEY = "nova-ready-sound";
const NOTICE_MS = 15_000;
const MAX_NOTICES = 4;

// Kho nhỏ để nút bật/tắt trên thanh trên và bộ báo dùng chung một giá trị.
const soundListeners = new Set<() => void>();
function readSound(): boolean {
  try { return window.localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; }
}
let soundOn = readSound();
function setSound(value: boolean) {
  soundOn = value;
  try { window.localStorage.setItem(SOUND_KEY, value ? "on" : "off"); } catch { /* trình duyệt chặn lưu: chỉ nhớ trong phiên */ }
  soundListeners.forEach((listener) => listener());
}
function useSoundOn(): boolean {
  return useSyncExternalStore(
    (listener) => { soundListeners.add(listener); return () => soundListeners.delete(listener); },
    () => soundOn,
  );
}

let audio: AudioContext | null = null;
/** Hai tiếng "ting" ngắn. Trình duyệt chỉ cho phát sau khi người dùng đã bấm vào trang. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === "suspended") void audio.resume();
    const now = audio.currentTime;
    [0, 0.18].forEach((offset, index) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = "sine";
      osc.frequency.value = index === 0 ? 880 : 1175;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.25);
      osc.connect(gain).connect(audio!.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    });
  } catch {
    // Không phát được tiếng thì vẫn còn thẻ báo trên màn.
  }
}

function isReadyEvent(event: RealtimeEvent): boolean {
  return event.type === "ORDER_UPDATED" && event.data.reason === "ITEM_READY";
}

export function ReadySoundToggle() {
  const on = useSoundOn();
  return (
    <button
      type="button"
      className="nova-sound-toggle"
      aria-pressed={on}
      title="Âm báo khi bếp làm xong món"
      onClick={() => { setSound(!on); if (!on) chime(); }}
    >
      {on ? "Âm báo món: bật" : "Âm báo món: tắt"}
    </button>
  );
}

export function ReadyNotifier() {
  const navigate = useNavigate();
  const [notices, setNotices] = useState<ReadyNotice[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const onEvent = useCallback((event: RealtimeEvent) => {
    const data = event.data;
    const tableId = typeof data.table_id === "string" ? data.table_id : "";
    const id = typeof data.item_id === "string" ? data.item_id : `${tableId}-${event.at}`;
    const table = typeof data.table_code === "string" ? data.table_code : "";
    const name = typeof data.menu_item_name === "string" ? data.menu_item_name : "Món";
    const quantity = typeof data.quantity === "number" ? data.quantity : null;
    const notice: ReadyNotice = {
      id,
      tableId,
      title: table ? `Bàn ${table}: món sẵn sàng` : "Có món sẵn sàng",
      detail: `${quantity ? `${quantity}× ` : ""}${name} · ra bếp lấy`,
    };
    setNotices((current) => (current.some((item) => item.id === id) ? current : [notice, ...current].slice(0, MAX_NOTICES)));
    if (!timers.current.has(id)) timers.current.set(id, window.setTimeout(() => dismiss(id), NOTICE_MS));
    if (soundOn) chime();
  }, [dismiss]);

  useRealtime({ channel: "tables", filter: isReadyEvent, onEvent, onRefresh: () => undefined });

  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach((timer) => window.clearTimeout(timer)); pending.clear(); };
  }, []);

  if (notices.length === 0) return null;
  return (
    <div className="nova-ready-stack" role="status" aria-live="polite" data-testid="ready-notices">
      {notices.map((notice) => (
        <div key={notice.id} className="nova-ready-toast">
          <button
            type="button"
            className="nova-ready-open"
            onClick={() => { dismiss(notice.id); if (notice.tableId) navigate(`/tables/${encodeURIComponent(notice.tableId)}`); }}
          >
            <strong>{notice.title}</strong>
            <span>{notice.detail}</span>
          </button>
          <button type="button" className="nova-ready-close" aria-label="Đóng thông báo" onClick={() => dismiss(notice.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
