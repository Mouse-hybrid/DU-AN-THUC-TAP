import type { KitchenQueueResponse, KitchenStationResponse } from "../api/kitchen";
import { KdsTicket, type KdsAction } from "./KdsTicket";
import { StateCard } from "./StateCard";

interface KdsBoardProps {
  entries: KitchenQueueResponse;
  stations: KitchenStationResponse;
  /** Hành động của từng món (tab "Món trễ" có cả món chờ nấu lẫn đang nấu). */
  resolveAction: (entry: KitchenQueueResponse[number]) => KdsAction;
  canAct: boolean;
  busyItemIds: ReadonlySet<string>;
  onAction: (entry: KitchenQueueResponse[number]) => void;
}

export function KdsBoard({ entries, stations, resolveAction, canAct, busyItemIds, onAction }: KdsBoardProps) {
  const stationNames = new Map(stations.map((station) => [station.id, station.name]));

  if (entries.length === 0) {
    return <StateCard kind="empty" title="Chưa có món" message="Không có món phù hợp với bộ lọc hiện tại." />;
  }

  return (
    <section className="nova-kds-board" aria-live="polite">
      {entries.map((entry) => (
        <KdsTicket
          key={entry.id}
          entry={entry}
          stationName={stationNames.get(entry.station_id) ?? "Chưa xác định"}
          action={resolveAction(entry)}
          canAct={canAct}
          busy={busyItemIds.has(entry.order_item_id)}
          onAction={onAction}
        />
      ))}
    </section>
  );
}
