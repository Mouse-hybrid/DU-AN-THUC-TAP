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

/** Lỗi khi quản lý sửa bảng quyền (màn 94). `conflict` khác nhau giữa sửa một ô và khôi phục mặc định. */
export function permissionErrorMessage(error: unknown, conflict: string): string {
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 422) return error.message || "Danh sách vai trò chưa hợp lệ.";
    if (error.status === 403) return "Bạn không có quyền chỉnh phân quyền. Bảng quyền đã được tải lại.";
    if (error.status === 404) return "Không tìm thấy quyền này. Bảng quyền đã được tải lại.";
    if (error.status === 409) return conflict;
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

/** Lỗi khi thu tiền, hủy lần thu, hoàn tiền (màn 20, 21, 100). Câu 409 riêng theo thao tác vì client chỉ trả câu chung. */
export function paymentErrorMessage(error: unknown, conflict: string): string {
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 422) return error.message || "Số tiền hoặc thông tin chưa hợp lệ.";
    if (error.status === 403) return "Bạn không có quyền thực hiện thao tác thanh toán này.";
    if (error.status === 404) return "Không tìm thấy đơn hoặc lần thanh toán. Dữ liệu đã được tải lại.";
    if (error.status === 409) return conflict;
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

/** Lỗi khi chuyển bàn, gộp bàn, tách bill. 409/422 lấy ngữ cảnh theo thao tác. */
export function moveErrorMessage(error: unknown, kind: "transfer" | "merge" | "split"): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Chỉ phục vụ hoặc quản lý mới được chuyển/gộp bàn và tách bill.";
    if (error.status === 404) return kind === "split" ? "Không tìm thấy đơn hoặc món cần tách." : "Không tìm thấy bàn. Danh sách bàn có thể đã đổi.";
    if (error.status === 409) {
      if (kind === "transfer") return "Bàn không còn ở trạng thái phù hợp (bàn đi phải đang phục vụ, bàn đến phải trống hoặc đã đặt).";
      if (kind === "merge") return "Không gộp được: bàn đang chờ thanh toán/dọn, đã gộp, hoặc bàn phụ còn ưu đãi đang áp.";
      return "Không tách được: đơn đang chờ thanh toán, đã áp ưu đãi, hoặc món đã vào bếp chỉ tách nguyên dòng.";
    }
    if (error.status === 422) return error.message || "Lựa chọn chưa hợp lệ (không chọn cùng một bàn; phải để lại ít nhất 1 món).";
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}

export type RewardAction = "lookup" | "create" | "attach" | "apply" | "remove";

/** Lỗi khi tra khách, gắn khách, áp/gỡ ưu đãi. */
export function rewardErrorMessage(error: unknown, action: RewardAction): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return action === "apply" || action === "remove"
        ? "Bạn không có quyền áp dụng ưu đãi (áp ngoại lệ cần quản lý)."
        : "Bạn không có quyền xem hoặc gắn khách hàng.";
    }
    if (error.status === 404) return action === "lookup" ? "Không tìm thấy khách." : "Không tìm thấy đơn, khách hoặc ưu đãi. Dữ liệu đã được tải lại.";
    if (error.status === 409) {
      if (action === "create") return "Số điện thoại này đã có trong hệ thống. Hãy tra lại số để gắn khách.";
      if (action === "attach") return "Không đổi được khách: đơn đã thanh toán, khách bị khóa, hoặc đang đổi điểm.";
      if (action === "apply") return error.message || "Không áp được ưu đãi: không đủ điều kiện, hết điểm hoặc đơn đã thanh toán một phần.";
      return "Không gỡ được ưu đãi: đơn đã thanh toán.";
    }
    if (error.status === 422) return error.message || (action === "create" ? "Số điện thoại hoặc tên chưa hợp lệ." : "Dữ liệu chưa hợp lệ.");
    if (error.status >= 500) return "Máy chủ đang gặp sự cố. Dữ liệu hiện có vẫn được giữ lại.";
    if (error.status === 0) return navigator.onLine
      ? "Không thể kết nối hoặc máy chủ phản hồi quá chậm. Vui lòng thử lại."
      : "Bạn đang ngoại tuyến. Thao tác chưa được gửi.";
  }
  return getErrorMessage(error);
}
