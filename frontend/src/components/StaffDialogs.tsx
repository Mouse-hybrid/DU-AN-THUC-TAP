import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { StaffDetail, StaffRoleCode } from "../api/staff";
import { validateFullName, validateNewPassword, validateUsername } from "../utils/password";
import { ROLE_ORDER, roleLabel } from "../utils/roleLabels";
import { Button } from "./Button";
import { PasswordField } from "./PasswordField";

/** Trả về câu lỗi để hiện trong hộp thoại, hoặc null khi thành công (trang tự đóng hộp thoại). */
type SubmitResult = Promise<string | null>;

interface DialogFrameProps {
  title: string;
  titleId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
  submitVariant?: "primary" | "danger";
  children: ReactNode;
  error: string;
}

function DialogFrame({ title, titleId, busy, onCancel, onSubmit, submitLabel, submitDisabled = false, submitVariant = "primary", children, error }: DialogFrameProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy) onSubmit();
  }

  return (
    <div className="nova-dialog-backdrop" role="presentation">
      <form className="nova-confirm-dialog nova-form-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit} noValidate>
        <h2 id={titleId}>{title}</h2>
        <div className="nova-form-dialog-body">{children}</div>
        {error ? <div className="nova-alert" role="alert">{error}</div> : null}
        <div className="nova-confirm-actions">
          <Button variant="secondary" type="button" accessibleLabel="Hủy thao tác" disabled={busy} onClick={onCancel}>Hủy</Button>
          <Button variant={submitVariant} type="submit" accessibleLabel={submitLabel} busy={busy} disabled={submitDisabled}>{submitLabel}</Button>
        </div>
      </form>
    </div>
  );
}

interface RoleSelectProps {
  id: string;
  value: StaffRoleCode;
  onChange: (role: StaffRoleCode) => void;
  disabled?: boolean;
  hint?: string;
}

function RoleSelect({ id, value, onChange, disabled = false, hint }: RoleSelectProps) {
  return (
    <div className="nova-field">
      <label htmlFor={id}>Vai trò</label>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as StaffRoleCode)}>
        {ROLE_ORDER.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
      </select>
      {hint ? <p className="nova-field-hint">{hint}</p> : null}
    </div>
  );
}

/** Chạy onSubmit một lần tại một thời điểm, chặn bấm đúp kể cả khi React chưa kịp render lại. */
function useSubmitGuard() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task: () => SubmitResult) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const message = await task();
      if (message) setError(message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export interface CreateStaffValues {
  username: string;
  full_name: string;
  role: StaffRoleCode;
  password: string;
}

interface CreateStaffDialogProps {
  onCancel: () => void;
  onSubmit: (values: CreateStaffValues) => SubmitResult;
}

export function CreateStaffDialog({ onCancel, onSubmit }: CreateStaffDialogProps) {
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<StaffRoleCode>("WAITER");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const guard = useSubmitGuard();

  const cleanUsername = username.trim();
  const cleanName = fullName.trim();
  const errors = {
    fullName: validateFullName(cleanName),
    username: validateUsername(cleanUsername),
    password: validateNewPassword(password),
  };

  function submit() {
    setSubmitted(true);
    if (errors.fullName || errors.username || errors.password) return;
    void guard.run(() => onSubmit({ username: cleanUsername, full_name: cleanName, role, password }));
  }

  return (
    <DialogFrame title="Thêm nhân viên" titleId="nova-staff-create-title" busy={guard.busy} error={guard.error} onCancel={onCancel} onSubmit={submit} submitLabel="Tạo nhân viên">
      <div className="nova-field">
        <label htmlFor="nova-staff-fullname">Họ tên</label>
        <input id="nova-staff-fullname" autoFocus autoComplete="off" value={fullName} maxLength={100} aria-invalid={submitted && Boolean(errors.fullName)} onChange={(event) => setFullName(event.target.value)} />
        {submitted && errors.fullName ? <p className="nova-field-error">{errors.fullName}</p> : null}
      </div>
      <div className="nova-field">
        <label htmlFor="nova-staff-username">Tên đăng nhập</label>
        <input id="nova-staff-username" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} maxLength={100} aria-invalid={submitted && Boolean(errors.username)} onChange={(event) => setUsername(event.target.value)} />
        {submitted && errors.username ? <p className="nova-field-error">{errors.username}</p> : <p className="nova-field-hint">Dùng để đăng nhập, không đổi được sau khi tạo.</p>}
      </div>
      <RoleSelect id="nova-staff-role" value={role} onChange={setRole} />
      <PasswordField
        id="nova-staff-password"
        label="Mật khẩu ban đầu"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        {...(submitted && errors.password ? { error: errors.password } : { hint: "Tối thiểu 8 ký tự. Nhân viên có thể tự đổi trong Hồ sơ của tôi." })}
      />
    </DialogFrame>
  );
}

export interface EditStaffValues {
  full_name?: string;
  role?: StaffRoleCode;
}

interface EditStaffDialogProps {
  staff: StaffDetail;
  isSelf: boolean;
  onCancel: () => void;
  onSubmit: (values: EditStaffValues) => SubmitResult;
}

export function EditStaffDialog({ staff, isSelf, onCancel, onSubmit }: EditStaffDialogProps) {
  const [fullName, setFullName] = useState(staff.full_name);
  const [role, setRole] = useState<StaffRoleCode>(staff.role);
  const [submitted, setSubmitted] = useState(false);
  const guard = useSubmitGuard();

  const cleanName = fullName.trim();
  const nameError = validateFullName(cleanName);
  const nameChanged = cleanName !== staff.full_name;
  const roleChanged = role !== staff.role;
  const changed = nameChanged || roleChanged;

  function submit() {
    setSubmitted(true);
    if (nameError || !changed) return;
    const values: EditStaffValues = {};
    if (nameChanged) values.full_name = cleanName;
    if (roleChanged) values.role = role;
    void guard.run(() => onSubmit(values));
  }

  return (
    <DialogFrame title="Sửa nhân viên" titleId="nova-staff-edit-title" busy={guard.busy} error={guard.error} onCancel={onCancel} onSubmit={submit} submitLabel="Lưu thay đổi" submitDisabled={!changed}>
      <p className="nova-form-dialog-meta">Tên đăng nhập: <strong>{staff.username}</strong></p>
      <div className="nova-field">
        <label htmlFor="nova-staff-fullname">Họ tên</label>
        <input id="nova-staff-fullname" autoFocus autoComplete="off" value={fullName} maxLength={100} aria-invalid={submitted && Boolean(nameError)} onChange={(event) => setFullName(event.target.value)} />
        {submitted && nameError ? <p className="nova-field-error">{nameError}</p> : null}
      </div>
      <RoleSelect
        id="nova-staff-role"
        value={role}
        onChange={setRole}
        disabled={isSelf}
        {...(isSelf ? { hint: "Không thể tự đổi vai trò của chính mình." } : {})}
      />
      {roleChanged ? <p className="nova-form-dialog-warning" role="note">Đổi vai trò sẽ đăng xuất {staff.full_name} khỏi mọi thiết bị. Họ cần đăng nhập lại để dùng quyền mới.</p> : null}
    </DialogFrame>
  );
}

interface ResetPasswordDialogProps {
  staff: StaffDetail;
  onCancel: () => void;
  onSubmit: (newPassword: string) => SubmitResult;
}

export function ResetPasswordDialog({ staff, onCancel, onSubmit }: ResetPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const guard = useSubmitGuard();
  const error = validateNewPassword(password);

  function submit() {
    setSubmitted(true);
    if (error) return;
    void guard.run(() => onSubmit(password));
  }

  return (
    <DialogFrame title="Đặt lại mật khẩu" titleId="nova-staff-reset-title" busy={guard.busy} error={guard.error} onCancel={onCancel} onSubmit={submit} submitLabel="Đặt lại mật khẩu">
      <p className="nova-form-dialog-meta">Nhân viên: <strong>{staff.full_name}</strong> ({staff.username})</p>
      <PasswordField
        id="nova-staff-new-password"
        label="Mật khẩu mới"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        autoFocus
        {...(submitted && error ? { error } : { hint: "Tối thiểu 8 ký tự. Hãy báo mật khẩu mới cho nhân viên qua kênh riêng." })}
      />
      <p className="nova-form-dialog-warning" role="note">Nhân viên sẽ bị đăng xuất khỏi mọi thiết bị và phải dùng mật khẩu mới.</p>
    </DialogFrame>
  );
}

interface ToggleLockDialogProps {
  staff: StaffDetail;
  onCancel: () => void;
  onSubmit: () => SubmitResult;
}

export function ToggleLockDialog({ staff, onCancel, onSubmit }: ToggleLockDialogProps) {
  const guard = useSubmitGuard();
  const locking = staff.is_active;
  return (
    <DialogFrame
      title={locking ? "Khóa tài khoản?" : "Mở khóa tài khoản?"}
      titleId="nova-staff-lock-title"
      busy={guard.busy}
      error={guard.error}
      onCancel={onCancel}
      onSubmit={() => void guard.run(onSubmit)}
      submitLabel={locking ? "Khóa tài khoản" : "Mở khóa"}
      submitVariant={locking ? "danger" : "primary"}
    >
      {locking ? (
        <p><strong>{staff.full_name}</strong> ({staff.username}) sẽ bị đăng xuất khỏi mọi thiết bị và không đăng nhập được cho tới khi được mở khóa. Dữ liệu đơn hàng cũ vẫn được giữ.</p>
      ) : (
        <p><strong>{staff.full_name}</strong> ({staff.username}) sẽ đăng nhập lại được bằng mật khẩu hiện tại.</p>
      )}
    </DialogFrame>
  );
}
