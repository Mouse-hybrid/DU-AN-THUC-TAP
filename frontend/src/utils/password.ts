export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt chỉ đọc 72 byte đầu, backend từ chối mật khẩu dài hơn. */
export const PASSWORD_MAX_BYTES = 72;

/** Trả về câu lỗi tiếng Việt, hoặc chuỗi rỗng nếu mật khẩu hợp lệ. */
export function validateNewPassword(value: string): string {
  if (value.length < PASSWORD_MIN_LENGTH) return `Mật khẩu cần tối thiểu ${PASSWORD_MIN_LENGTH} ký tự.`;
  if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) return `Mật khẩu tối đa ${PASSWORD_MAX_BYTES} byte (khoảng 70 ký tự thường).`;
  return "";
}

const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateUsername(value: string): string {
  if (value.length < 3) return "Tên đăng nhập cần tối thiểu 3 ký tự.";
  if (value.length > 100) return "Tên đăng nhập tối đa 100 ký tự.";
  if (!USERNAME_PATTERN.test(value)) return "Tên đăng nhập chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới và gạch ngang.";
  return "";
}

export function validateFullName(value: string): string {
  if (!value) return "Vui lòng nhập họ tên.";
  if (value.length > 100) return "Họ tên tối đa 100 ký tự.";
  return "";
}
