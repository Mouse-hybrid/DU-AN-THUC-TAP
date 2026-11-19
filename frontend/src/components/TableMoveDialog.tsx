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
  onSubmit: (targetIds: string[], capacityOverrideReason?: string) => Promise<string | null>;
  /** Có quyền OVERRIDE: được chuyển sang bàn ít chỗ hơn số khách nếu ghi lý do. */
  canOverrideCapacity?: boolean;
  onCancel: () => void;
}

const TRANSFER_TARGETS = new Set(["AVAILABLE", "RESERVED"]);
const MERGE_TARGETS = new Set(["AVAILABLE", "RESERVED", "OCCUPIED"]);

export function TableMoveDialog({ mode, tableId, tableCode, onSubmit, onCancel, canOverrideCapacity = false }: TableMoveDialogProps) {
  const [tables, setTables] = useState<TableListResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Server chặn vì bàn đích thiếu chỗ ("Bàn B3 chỉ có 2 chỗ…"): Supervisor được vượt nếu ghi lý do.
  const [capacityBlocked, setCapacityBlocked] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
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
    setCapacityBlocked(false);
    setOverrideReason("");
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
      const reason = capacityBlocked && overrideReason.trim().length >= 3 ? overrideReason.trim() : undefined;
      if (capacityBlocked && canOverrideCapacity && !reason) {
        setError("Ghi lý do (ít nhất 3 ký tự) để chuyển vượt sức chứa.");
        return;
      }
      const message = await onSubmit(selected, reason);
      if (message) {
        setError(message);
        if (mode === "transfer" && /chỉ có \d+ chỗ/.test(message)) setCapacityBlocked(true);
      }
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
      submitLabel={mode === "transfer" ? (capacityBlocked && canOverrideCapacity ? "Vẫn chuyển (vượt sức chứa)" : "Chuyển bàn") : "Gộp bàn"}
      submitDisabled={selected.length === 0 || tables === null}
      error={error}
    >
      <p>
        {mode === "transfer"
          ? "Toàn bộ đơn, món và phiếu bếp chuyển sang bàn mới. Bàn cũ trống ngay để xếp khách mới. Bàn mới phải đủ chỗ cho số khách."
          : "Món của các bàn được chọn sẽ gộp vào hóa đơn của bàn này. Không thể hoàn tác việc gộp."}
      </p>
      {capacityBlocked && canOverrideCapacity ? (
        <label className="nova-field">
          <span>Lý do vượt sức chứa (vd kê thêm ghế)</span>
          <input value={overrideReason} maxLength={500} onChange={(event) => { setOverrideReason(event.target.value); setError(""); }} disabled={busy} />
        </label>
      ) : null}
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
