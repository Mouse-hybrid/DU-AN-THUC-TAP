import { useEffect, useRef, useState } from "react";
import { listModifiers, type MenuItem, type ModifierGroup } from "../api/menu";
import { orderErrorMessage } from "../utils/errorMessages";
import { formatVnd } from "../utils/format";
import { FormDialog } from "./FormDialog";

interface ModifierDialogProps {
  item: Pick<MenuItem, "id" | "name" | "price">;
  /** Có sẵn nhóm tùy chọn (thực đơn QR) thì không cần gọi API. */
  groups?: ModifierGroup[];
  onConfirm: (optionIds: string[]) => void;
  onCancel: () => void;
}

function groupError(group: ModifierGroup, count: number): string {
  if (count < group.min_select) {
    return group.min_select === 1 && group.max_select === 1 ? "Chọn 1 mục" : `Chọn ít nhất ${group.min_select} mục`;
  }
  if (count > group.max_select) return `Chọn tối đa ${group.max_select} mục`;
  return "";
}

/** Chọn size/topping trước khi thêm món vào đơn (màn 10). */
export function ModifierDialog({ item, groups: preset, onConfirm, onCancel }: ModifierDialogProps) {
  const [groups, setGroups] = useState<ModifierGroup[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [tried, setTried] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    let active = true;
    function accept(data: ModifierGroup[]) {
      const sorted = data.filter((group) => group.is_active).sort((a, b) => a.sort_order - b.sort_order);
      setGroups(sorted);
      // Nhóm chọn đúng 1 mục: chọn sẵn mục có sẵn đầu tiên cho nhanh.
      const initial: Record<string, string[]> = {};
      for (const group of sorted) {
        const first = group.options.find((option) => option.is_available);
        if (group.min_select === 1 && group.max_select === 1 && first) initial[group.id] = [first.id];
      }
      setPicked(initial);
    }
    if (preset) {
      accept(preset);
      return undefined;
    }
    listModifiers(item.id)
      .then((data) => { if (active) accept(data); })
      .catch((error: unknown) => { if (active) setLoadError(orderErrorMessage(error)); });
    return () => { active = false; };
  }, [item.id, preset]);

  function toggle(group: ModifierGroup, optionId: string) {
    setPicked((current) => {
      const list = current[group.id] ?? [];
      if (group.max_select === 1) return { ...current, [group.id]: [optionId] };
      if (list.includes(optionId)) return { ...current, [group.id]: list.filter((id) => id !== optionId) };
      if (list.length >= group.max_select) return current;
      return { ...current, [group.id]: [...list, optionId] };
    });
  }

  const extra = (groups ?? []).reduce((sum, group) => {
    const ids = picked[group.id] ?? [];
    return sum + group.options.filter((option) => ids.includes(option.id)).reduce((s, option) => s + Number(option.price_delta), 0);
  }, 0);
  const invalid = (groups ?? []).some((group) => groupError(group, (picked[group.id] ?? []).length) !== "");

  function submit() {
    if (done.current) return;
    if (invalid) {
      setTried(true);
      return;
    }
    done.current = true;
    onConfirm((groups ?? []).flatMap((group) => picked[group.id] ?? []));
  }

  return (
    <FormDialog
      title={`Tùy chọn cho ${item.name}`}
      titleId="nova-modifier-title"
      busy={false}
      onCancel={onCancel}
      onSubmit={submit}
      submitLabel="Thêm vào đơn"
      submitDisabled={groups === null}
      error={loadError}
      wide
    >
      {groups === null && !loadError ? <p className="nova-readonly-note">Đang tải tùy chọn…</p> : null}
      {(groups ?? []).map((group) => {
        const ids = picked[group.id] ?? [];
        const message = tried ? groupError(group, ids.length) : "";
        const single = group.max_select === 1;
        return (
          <fieldset key={group.id} className="nova-modifier-group" data-testid="modifier-group">
            <legend>
              {group.name}
              <small>{group.min_select > 0 ? " · Bắt buộc" : " · Tùy chọn"}{group.max_select > 1 ? ` · tối đa ${group.max_select}` : ""}</small>
            </legend>
            {group.options.map((option) => (
              <label key={option.id} className={`nova-modifier-option${option.is_available ? "" : " nova-modifier-option--off"}`}>
                <input
                  type={single ? "radio" : "checkbox"}
                  name={`group-${group.id}`}
                  checked={ids.includes(option.id)}
                  disabled={!option.is_available}
                  onChange={() => toggle(group, option.id)}
                />
                <span>{option.name}{option.is_available ? "" : " (hết)"}</span>
                <small>{Number(option.price_delta) > 0 ? `+${formatVnd(option.price_delta)}` : ""}</small>
              </label>
            ))}
            {message ? <p className="nova-field-error" role="alert">{message}</p> : null}
          </fieldset>
        );
      })}
      {groups !== null ? (
        <p className="nova-modifier-total" data-testid="modifier-total">
          Giá: <strong>{formatVnd(String(Number(item.price) + extra))}</strong>
        </p>
      ) : null}
    </FormDialog>
  );
}
