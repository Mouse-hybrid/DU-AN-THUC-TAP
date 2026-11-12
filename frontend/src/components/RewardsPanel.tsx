import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderDetail } from "../api/orders";
import {
  applyReward,
  attachCustomer,
  createCustomer,
  findCustomersByPhone,
  getCustomer,
  listEligibleRewards,
  removeReward,
  type Customer,
  type EligibleReward,
} from "../api/rewards";
import type { FlashMessage } from "../auth/storage";
import { rewardErrorMessage, type RewardAction } from "../utils/errorMessages";
import { formatVnd } from "../utils/format";
import { createIdempotencyKey } from "../utils/idempotency";
import { Button } from "./Button";
import { FormDialog } from "./FormDialog";

interface RewardsPanelProps {
  order: OrderDetail;
  canCustomer: boolean;
  canReward: boolean;
  canOverride: boolean;
  locked: boolean;
  notify: (message: FlashMessage) => void;
  onChanged: () => Promise<void>;
}

const OVERRIDABLE = new Set(["NOT_STARTED", "EXPIRED", "MIN_ORDER", "USAGE_LIMIT"]);
const PHONE_PATTERN = /^0\d{9}$/;

function normalizePhone(value: string): string {
  return value.replace(/[\s.-]/g, "");
}

export function RewardsPanel({ order, canCustomer, canReward, canOverride, locked, notify, onChanged }: RewardsPanelProps) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerError, setCustomerError] = useState("");
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<Customer | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [fullName, setFullName] = useState("");
  const [consent, setConsent] = useState(false);
  const [rewards, setRewards] = useState<EligibleReward[]>([]);
  const [rewardsError, setRewardsError] = useState("");
  const [points, setPoints] = useState<Record<string, string>>({});
  const [overrideFor, setOverrideFor] = useState<EligibleReward | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const inFlight = useRef(false);

  const partiallyPaid = Number(order.amount_paid) > 0;
  const frozen = locked || partiallyPaid;
  const applied = order.applied_reward ?? null;
  const customerId = order.customer_id ?? null;
  const reloadKey = `${order.id}|${customerId ?? ""}|${order.subtotal}|${applied?.id ?? ""}|${order.status}`;

  // Tải thông tin khách đang gắn vào đơn.
  useEffect(() => {
    let active = true;
    setCustomerError("");
    if (!customerId || !canCustomer) {
      setCustomer(null);
      return;
    }
    getCustomer(customerId)
      .then((data) => { if (active) setCustomer(data); })
      .catch((error: unknown) => { if (active) setCustomerError(rewardErrorMessage(error, "lookup")); });
    return () => { active = false; };
  }, [customerId, canCustomer]);

  const loadRewards = useCallback(async () => {
    if (!canReward) return;
    try {
      setRewards(await listEligibleRewards(order.id));
      setRewardsError("");
    } catch (error) {
      setRewardsError(rewardErrorMessage(error, "apply"));
    }
    // reloadKey gom các trường làm thay đổi kết quả đủ điều kiện.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReward, reloadKey]);

  useEffect(() => { void loadRewards(); }, [loadRewards]);

  async function run(label: string, action: RewardAction, work: () => Promise<string | void>, inDialog = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(label);
    setFormError("");
    try {
      const success = await work();
      if (success) notify({ message: success, type: "success" });
    } catch (error) {
      const message = rewardErrorMessage(error, action);
      if (inDialog) setFormError(message);
      else notify({ message, type: "error" });
      if (action !== "lookup" && action !== "create") await onChanged().catch(() => undefined);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function lookup() {
    const normalized = normalizePhone(phone);
    setFound(null);
    setNotFound(false);
    if (!PHONE_PATTERN.test(normalized)) {
      setFormError("Số điện thoại gồm 10 chữ số, bắt đầu bằng 0.");
      return;
    }
    void run("lookup", "lookup", async () => {
      const list = await findCustomersByPhone(normalized);
      const first = list[0];
      if (first) setFound(first);
      else setNotFound(true);
    });
  }

  function attach(target: Customer | null) {
    void run(target ? "attach" : "detach", "attach", async () => {
      await attachCustomer(order.id, target?.id ?? null, createIdempotencyKey());
      await onChanged();
      setFound(null);
      setNotFound(false);
      setPhone("");
      return target ? "Đã gắn khách vào đơn." : "Đã bỏ khách khỏi đơn.";
    });
  }

  function createAndAttach() {
    if (!consent) {
      setFormError("Cần khách đồng ý lưu thông tin trước khi tạo hội viên.");
      return;
    }
    void run("create", "create", async () => {
      const created = await createCustomer(
        { phone: normalizePhone(phone), full_name: fullName.trim() || null, consent: true },
        createIdempotencyKey(),
      );
      await attachCustomer(order.id, created.id, createIdempotencyKey());
      await onChanged();
      setNotFound(false);
      setPhone("");
      setFullName("");
      setConsent(false);
      return "Đã tạo hội viên và gắn vào đơn.";
    });
  }

  function apply(reward: EligibleReward, override?: string) {
    const body: { reward_id: string; points?: number; override_reason?: string } = { reward_id: reward.reward_id };
    if (reward.reward_type === "POINTS") {
      const value = Number(points[reward.reward_id] ?? reward.max_points);
      if (!Number.isInteger(value) || value <= 0 || value > reward.max_points) {
        notify({ message: `Số điểm phải từ 1 đến ${reward.max_points}.`, type: "error" });
        return;
      }
      body.points = value;
    }
    if (override) body.override_reason = override;
    void run(`apply:${reward.reward_id}`, "apply", async () => {
      await applyReward(order.id, body, createIdempotencyKey());
      setOverrideFor(null);
      setOverrideReason("");
      await onChanged();
      return `Đã áp dụng ưu đãi ${reward.name}.`;
    }, Boolean(override));
  }

  function remove() {
    if (!applied) return;
    void run("remove", "remove", async () => {
      await removeReward(order.id, applied.id, createIdempotencyKey());
      await onChanged();
      return "Đã gỡ ưu đãi.";
    });
  }

  if (!canCustomer && !canReward) return null;
  const closed = order.status === "PAID" || order.status === "CLOSED";
  if (closed && !applied && !customerId) return null;

  return (
    <section className="nova-rewards" aria-labelledby="nova-rewards-title" data-testid="rewards-panel">
      <h2 id="nova-rewards-title">Khách hàng &amp; ưu đãi</h2>
      {partiallyPaid && !closed ? <p className="nova-readonly-note">Đơn đã thanh toán một phần nên không đổi khách hoặc ưu đãi.</p> : null}

      {canCustomer ? (
        <div className="nova-rewards-block">
          {customerId ? (
            <div className="nova-customer-card" data-testid="customer-card">
              {customer ? (
                <>
                  <strong>{customer.full_name || "Khách chưa có tên"}</strong>
                  <span>{customer.phone} · {customer.member_code}</span>
                  <span data-testid="customer-points">{customer.points_balance} điểm</span>
                </>
              ) : <span>{customerError || "Đang tải thông tin khách…"}</span>}
              {!closed ? (
                <Button variant="secondary" type="button" accessibleLabel="Bỏ khách khỏi đơn" busy={busy === "detach"} disabled={frozen || busy !== null} onClick={() => attach(null)}>Bỏ khách</Button>
              ) : null}
            </div>
          ) : !closed ? (
            <form className="nova-customer-lookup" onSubmit={(event) => { event.preventDefault(); lookup(); }} noValidate>
              <div className="nova-field">
                <label htmlFor="nova-customer-phone">Số điện thoại khách</label>
                <input id="nova-customer-phone" inputMode="tel" autoComplete="off" value={phone} disabled={frozen} onChange={(event) => { setPhone(event.target.value); setFormError(""); setFound(null); setNotFound(false); }} placeholder="09xxxxxxxx" />
              </div>
              <Button variant="secondary" type="submit" accessibleLabel="Tìm khách theo số điện thoại" busy={busy === "lookup"} disabled={frozen || busy !== null || phone.trim() === ""}>Tìm khách</Button>
            </form>
          ) : null}
          {formError && !overrideFor ? <p className="nova-field-error" role="alert">{formError}</p> : null}
          {found ? (
            <div className="nova-customer-card" data-testid="customer-found">
              <strong>{found.full_name || "Khách chưa có tên"}</strong>
              <span>{found.phone} · {found.member_code} · {found.points_balance} điểm</span>
              {found.is_active ? (
                <Button variant="primary" type="button" accessibleLabel="Gắn khách vào đơn" busy={busy === "attach"} disabled={frozen || busy !== null} onClick={() => attach(found)}>Gắn vào đơn</Button>
              ) : <span className="nova-field-error">Khách đang bị khóa.</span>}
            </div>
          ) : null}
          {notFound ? (
            <div className="nova-customer-create" data-testid="customer-create">
              <p>Chưa có hội viên với số này. Tạo mới?</p>
              <div className="nova-field">
                <label htmlFor="nova-customer-name">Tên khách (không bắt buộc)</label>
                <input id="nova-customer-name" maxLength={120} value={fullName} onChange={(event) => setFullName(event.target.value)} />
              </div>
              <label className="nova-checkbox">
                <input type="checkbox" checked={consent} onChange={(event) => { setConsent(event.target.checked); setFormError(""); }} />
                Khách đồng ý lưu thông tin để tích điểm
              </label>
              <Button variant="primary" type="button" accessibleLabel="Tạo hội viên và gắn vào đơn" busy={busy === "create"} disabled={frozen || busy !== null} onClick={createAndAttach}>Tạo &amp; gắn vào đơn</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {applied ? (
        <div className="nova-applied-reward" data-testid="applied-reward">
          <div>
            <strong>{applied.reward_name}</strong>
            <span>Giảm {formatVnd(applied.discount_amount)}{applied.points_used > 0 ? ` · dùng ${applied.points_used} điểm` : ""}</span>
            {applied.invalid_reason ? <span className="nova-field-error" role="alert">Ưu đãi không còn hợp lệ ({applied.invalid_reason}). Hãy gỡ trước khi thanh toán.</span> : null}
          </div>
          {canReward && applied.status !== "COMMITTED" && !closed ? (
            <Button variant="secondary" type="button" accessibleLabel="Gỡ ưu đãi" busy={busy === "remove"} disabled={frozen || busy !== null} onClick={remove}>Gỡ ưu đãi</Button>
          ) : null}
        </div>
      ) : null}

      {canReward && !closed && !applied ? (
        <div className="nova-rewards-block">
          <h3>Ưu đãi có thể áp</h3>
          {rewardsError ? <p className="nova-field-error" role="alert">{rewardsError}</p> : null}
          {rewards.length === 0 && !rewardsError ? <p className="nova-readonly-note">Chưa có ưu đãi nào.</p> : null}
          <ul className="nova-reward-list">
            {rewards.map((reward) => {
              const isPoints = reward.reward_type === "POINTS";
              const overridable = !reward.eligible && canOverride && OVERRIDABLE.has(reward.reason_code ?? "");
              return (
                <li key={reward.reward_id} className="nova-reward-row" data-testid="reward-row">
                  <div>
                    <strong>{reward.name}</strong>
                    <small>
                      {reward.eligible
                        ? `Giảm ${formatVnd(reward.discount_amount)}`
                        : reward.reason || "Chưa đủ điều kiện"}
                    </small>
                  </div>
                  {reward.eligible && isPoints ? (
                    <input
                      className="nova-reward-points"
                      type="number"
                      min={1}
                      max={reward.max_points}
                      aria-label={`Số điểm đổi (tối đa ${reward.max_points})`}
                      value={points[reward.reward_id] ?? String(reward.max_points)}
                      disabled={frozen}
                      onChange={(event) => setPoints((current) => ({ ...current, [reward.reward_id]: event.target.value }))}
                    />
                  ) : null}
                  {reward.eligible ? (
                    <Button variant="primary" type="button" accessibleLabel={`Áp dụng ${reward.name}`} busy={busy === `apply:${reward.reward_id}`} disabled={frozen || busy !== null} onClick={() => apply(reward)}>Áp dụng</Button>
                  ) : overridable ? (
                    <Button variant="secondary" type="button" accessibleLabel={`Áp dụng ngoại lệ ${reward.name}`} disabled={frozen || busy !== null} onClick={() => { setOverrideFor(reward); setOverrideReason(""); setFormError(""); }}>Áp ngoại lệ</Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {overrideFor ? (
        <FormDialog
          title={`Áp dụng ngoại lệ: ${overrideFor.name}`}
          titleId="nova-override-reward-title"
          busy={busy !== null}
          onCancel={() => setOverrideFor(null)}
          onSubmit={() => apply(overrideFor, overrideReason.trim())}
          submitLabel="Áp dụng ngoại lệ"
          submitDisabled={overrideReason.trim().length < 3}
          error={formError}
        >
          <p>Bỏ qua điều kiện: {overrideFor.reason || "chưa đủ điều kiện"}. Thao tác được ghi nhật ký.</p>
          <div className="nova-field">
            <label htmlFor="nova-override-reward-reason">Lý do (ít nhất 3 ký tự)</label>
            <input id="nova-override-reward-reason" value={overrideReason} maxLength={200} onChange={(event) => setOverrideReason(event.target.value)} />
          </div>
        </FormDialog>
      ) : null}
    </section>
  );
}
