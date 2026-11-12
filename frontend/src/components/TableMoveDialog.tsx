import { useEffect, useRef, useState } from "react";
import { getErrorMessage } from "../api/client";
import { listTables, type TableListResponse } from "../api/tables";
import { FormDialog } from "./FormDialog";
import { getStatusMeta } from "./status";

interface TableMoveDialogProps {
  mode: "transfer" | "merge";
  tableId: string;
  tableCode: string;
  /** Trả về câu lỗi để hiện trong hộp thoại, hoặc null khi thành công. */
  onSubmit: (targetIds: string[]) => Promise<string | null>;
  onCancel: () => void;
}

const TRANSFER_TARGETS = new Set(["AVAILABLE", "RESERVED"]);
const MERGE_TARGETS = new Set(["AVAILABLE", "RESERVED", "OCCUPIED"]);

export function TableMoveDialog({ mode, tableId, tableCode, onSubmit, onCancel }: TableMoveDialogProps) {
  const [tables, setTables] = useState<TableListResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const allowed = mode === "transfer" ? TRANSFER_TARGETS : MERGE_TARGETS;

  useEffect(() => {
    let active = true;
    listTables()
      .then((data) => { if (active) setTables(data); })
      .catch((e: unknown) => { if (active) setLoadError(getErrorMessage(e)); });
    return () => { active = false; };
  }, []);

  const candidates = (tables ?? []).filter(
    (table) => table.id !== tableId && allowed.has(table.status) && !table.merged_into_table_id,
  );

  function toggle(id: string) {
    setError("");
    setSelected((current) => {
      if (mode === "transfer") return [id];
      if (current.includes(id)) return current.filter((value) => value !== id);
      return current.length >= 10 ? current : [...current, id];
    });
  }

  async function submit() {
    if (inFlight.current || selected.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const message = await onSubmit(selected);
      if (message) setError(message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const title = mode === "transfer" ? `Chuyển bàn ${tableCode} sang bàn khác` : `Gộp bàn vào bàn ${tableCode}`;
  return (
    <FormDialog
      title={title}
      titleId="nova-table-move-title"
      busy={busy}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      submitLabel={mode === "transfer" ? "Chuyển bàn" : "Gộp bàn"}
      submitDisabled={selected.length === 0 || tables === null}
      error={error}
    >
      <p>
        {mode === "transfer"
          ? "Toàn bộ đơn, món và phiếu bếp chuyển sang bàn mới. Bàn cũ chuyển sang trạng thái đang dọn."
          : "Món của các bàn được chọn sẽ gộp vào hóa đơn của bàn này. Không thể hoàn tác việc gộp."}
      </p>
      {tables === null && !loadError ? <p className="nova-readonly-note">Đang tải danh sách bàn…</p> : null}
      {loadError ? <div className="nova-alert" role="alert">{loadError}</div> : null}
      {tables !== null && candidates.length === 0 ? (
        <p className="nova-readonly-note" data-testid="move-empty">Không có bàn phù hợp để {mode === "transfer" ? "chuyển tới" : "gộp"}.</p>
      ) : null}
      <ul className="nova-move-list" aria-label="Chọn bàn">
        {candidates.map((table) => (
          <li key={table.id}>
            <label className="nova-move-option">
              <input
                type={mode === "transfer" ? "radio" : "checkbox"}
                name="move-target"
                checked={selected.includes(table.id)}
                onChange={() => toggle(table.id)}
                disabled={busy}
              />
              <span><strong>Bàn {table.code}</strong>{table.area_name ? ` · ${table.area_name}` : ""}</span>
              <small>{table.seats} chỗ · {getStatusMeta(table.status).label}</small>
            </label>
          </li>
        ))}
      </ul>
    </FormDialog>
  );
}
