import { ApiError, getErrorMessage } from "../api/client";

/** Lỗi khi thao tác với đơn (gọi món, tìm món). Dữ liệu đang hiển thị luôn được giữ lại. */
export function orderErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Bạn không có quyền thực hiện thao tác này.";
    if (error.status === 404) return "Không tìm thấy bàn, đơn hoặc món cần thao tác.";
    if (error.status === 409) return "Dữ liệu đơn đã thay đổi. Đơn đã được tải lại để bạn kiểm tra.";
    if (error.status === 422) return error.message || "Số lượng, ghi chú hoặc thông tin trạm bếp chưa hợp lệ.";
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

export interface AdminErrorContext {
  notFound: string;
  conflict: string;
}

/** Lỗi khi quản trị thực đơn (màn 102, 103). 422 dùng lại câu đã được client dịch từ detail dạng mảng. */
export function adminErrorMessage(error: unknown, context: AdminErrorContext): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Chỉ quản lý (SUPERVISOR) mới được thay đổi thực đơn.";
    if (error.status === 404) return context.notFound;
    if (error.status === 409) return context.conflict;
    if (error.status === 422) return error.message || "Dữ liệu chưa hợp lệ.";
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

/** Lỗi khi bếp bắt đầu nấu / đánh dấu sẵn sàng một món. */
export function kitchenActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Bạn không có quyền cập nhật món này.";
    if (error.status === 404) return "Không tìm thấy món trong đơn.";
    if (error.status === 409) return "Trạng thái món vừa thay đổi. Dữ liệu đã được tải lại.";
    if (error.status === 0 && !navigator.onLine) return "Không thể cập nhật khi đang ngoại tuyến.";
  }
  return getErrorMessage(error);
}

/** Lỗi khi quản trị nhân viên (màn 93) và đổi mật khẩu (màn 98). `conflict` là câu riêng cho từng thao tác vì client chỉ trả câu 409 chung. */
export function staffErrorMessage(error: unknown, conflict: string): string {
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 422) return error.message || "Dữ liệu chưa hợp lệ.";
    if (error.status === 403) return "Chỉ quản lý (SUPERVISOR) mới được quản lý nhân viên.";
    if (error.status === 404) return "Không tìm thấy nhân viên này. Danh sách đã được tải lại.";
    if (error.status === 409) return conflict;
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}
