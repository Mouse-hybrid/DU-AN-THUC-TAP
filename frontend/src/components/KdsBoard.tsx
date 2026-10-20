import type { KitchenQueueResponse, KitchenStationResponse } from "../api/kitchen";
import { KdsTicket, type KdsAction } from "./KdsTicket";
import { StateCard } from "./StateCard";

interface KdsBoardProps {
  entries: KitchenQueueResponse;
  stations: KitchenStationResponse;
  action: KdsAction;
  canAct: boolean;
  busyItemIds: ReadonlySet<string>;
  onAction: (entry: KitchenQueueResponse[number]) => void;
}

export function KdsBoard({ entries, stations, action, canAct, busyItemIds, onAction }: KdsBoardProps) {
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
          action={action}
          canAct={canAct}
          busy={busyItemIds.has(entry.order_item_id)}
          onAction={onAction}
        />
      ))}
    </section>
  );
}
