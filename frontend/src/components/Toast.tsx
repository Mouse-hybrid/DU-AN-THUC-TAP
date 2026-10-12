import { useEffect } from "react";
import type { FlashMessage } from "../auth/storage";

interface ToastProps extends FlashMessage {
  onClose: () => void;
}

export function Toast({ message, type, onClose }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 4_000);
    return () => window.clearTimeout(timer);
  }, [onClose]);

  return (
    <div className="nova-toast-region" aria-live="polite">
      <div className={`nova-toast nova-toast--${type}`} role={type === "error" ? "alert" : "status"}>
        <span>{message}</span>
        <button className="nova-toast-close" type="button" onClick={onClose} aria-label="Đóng thông báo">
          ×
        </button>
      </div>
    </div>
  );
}
