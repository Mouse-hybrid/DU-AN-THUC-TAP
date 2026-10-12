import { useEffect, useState } from "react";
import { Icon } from "./Icon";

export function OfflineBanner() {
  const [offline, setOffline] = useState(() => !navigator.onLine);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="nova-offline-banner" role="status">
      <Icon name="wifi-off" />
      Đang ngoại tuyến
    </div>
  );
}
