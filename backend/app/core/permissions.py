"""Ma trận phân quyền của hệ thống — nguồn duy nhất cho câu hỏi "role nào được
làm gì". Endpoint khai báo quyền cần có bằng `Depends(require_permission(...))`
(app/core/deps.py), không tự liệt kê role; đổi quyền chỉ sửa ở file này.

Permission Matrix gốc trong BRD (Action × Cashier/Waiter/Kitchen/Supervisor/
Customer) — đọc trực tiếp từ XML của file .docx vì bản trích xuất text thông
thường bị mất các ô ✓/✗ (nằm trong content-control, không phải text thường):

  Action                       Cashier Waiter Kitchen Supervisor Customer
  Create Order (POS)             v       x       x        x         x
  Create Order (QR)              x       x       x        x         v
  View KDS                       x       x       v        v         x
  Start Cooking                  x       x       v        v         x
  Mark Ready                     x       x       v        v         x
  Serve Food                     x       v       x        v         x
  Request Bill                   v       v       x        v         v
  Apply Reward                   v       x       x        v         x
  Process Payment                v       x       x        v         v
  Merge/Split/Transfer Table     x       v       x        v         v
  Override Actions               x       x       x        v         x

Customer không phải staff (khách quét QR, không đăng nhập) nên không có ở đây.
Các quyền còn lại không nằm trong 11 action trên, ghi rõ nguồn ở từng dòng.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Permission(str, Enum):
    ORDER_WRITE = "ORDER_WRITE"
    SEND_TO_KITCHEN = "SEND_TO_KITCHEN"
    REQUEST_BILLING = "REQUEST_BILLING"
    PROCESS_PAYMENT = "PROCESS_PAYMENT"
    OVERRIDE = "OVERRIDE"
    VIEW_KDS = "VIEW_KDS"
    KITCHEN_ACTION = "KITCHEN_ACTION"
    SERVE_FOOD = "SERVE_FOOD"
    TABLE_OPEN = "TABLE_OPEN"
    TABLE_MARK_CLEAN = "TABLE_MARK_CLEAN"
    TABLE_LAYOUT_MANAGE = "TABLE_LAYOUT_MANAGE"
    TABLE_TRANSFER = "TABLE_TRANSFER"
    QR_SESSION_MANAGE = "QR_SESSION_MANAGE"
    MENU_WRITE = "MENU_WRITE"
    AUDIT_READ = "AUDIT_READ"
    STAFF_MANAGE = "STAFF_MANAGE"
    CUSTOMER_ACCESS = "CUSTOMER_ACCESS"
    REWARD_APPLY = "REWARD_APPLY"
    LOYALTY_MANAGE = "LOYALTY_MANAGE"


@dataclass(frozen=True)
class PermissionRule:
    roles: tuple[str, ...]
    description: str


_FLOOR_ROLES = ("CASHIER", "WAITER", "SUPERVISOR")

PERMISSION_MATRIX: dict[Permission, PermissionRule] = {
    # PO chốt 09/10/2026 (thay "Create Order (POS)" chỉ Cashier trong BRD): luồng
    # phục vụ tại bàn cho cả Cashier, Waiter, Supervisor để 1 nhân viên đi hết được
    # luồng. PO chốt 12/10 (O1 = A): gọi thêm món sau khi đã gửi bếp cũng vậy.
    Permission.ORDER_WRITE: PermissionRule(_FLOOR_ROLES, "Tạo đơn, thêm/sửa/bỏ món"),
    Permission.SEND_TO_KITCHEN: PermissionRule(_FLOOR_ROLES, "Gửi món xuống bếp"),
    # = "Request Bill".
    Permission.REQUEST_BILLING: PermissionRule(_FLOOR_ROLES, "Yêu cầu thanh toán"),
    # = "Process Payment" — Waiter KHÔNG được (BRD: "Cannot process payment").
    Permission.PROCESS_PAYMENT: PermissionRule(
        ("CASHIER", "SUPERVISOR"), "Xác nhận thanh toán, đóng đơn"
    ),
    # = "Override Actions": void/refire món đã gửi bếp (Kitchen "Cannot modify orders").
    Permission.OVERRIDE: PermissionRule(("SUPERVISOR",), "Hủy món, làm lại món đã gửi bếp"),
    # = "View KDS".
    Permission.VIEW_KDS: PermissionRule(("KITCHEN", "SUPERVISOR"), "Xem hàng đợi bếp"),
    # = "Start Cooking" / "Mark Ready".
    Permission.KITCHEN_ACTION: PermissionRule(
        ("KITCHEN", "SUPERVISOR"), "Bắt đầu nấu, báo món xong"
    ),
    # = "Serve Food". BRD không liệt kê "Pickup" — coi là 1 bước trong trách nhiệm này
    # (Waiter lấy món từ bếp rồi mang ra bàn). Cần BA/PM xác nhận nếu thực tế tách vai trò.
    Permission.SERVE_FOOD: PermissionRule(("WAITER", "SUPERVISOR"), "Lấy món, mang món ra bàn"),
    # Không có trong BRD Matrix. HLR UC-TABLE-002 ghi actor "Waiter / Cashier";
    # PO chốt 09/10/2026: Cashier, Waiter, Supervisor.
    Permission.TABLE_OPEN: PermissionRule(_FLOOR_ROLES, "Mở bàn"),
    # Không có trong BRD Matrix; BRD chỉ nói bàn "remains CLEANING until confirmed".
    # Gán nhóm quản lý bàn — cần BA/PM xác nhận lại.
    Permission.TABLE_MARK_CLEAN: PermissionRule(("WAITER", "SUPERVISOR"), "Xác nhận đã dọn bàn"),
    # = "Merge/Split/Transfer Table" (Waiter, Supervisor; Customer không áp dụng cho staff).
    Permission.TABLE_TRANSFER: PermissionRule(("WAITER", "SUPERVISOR"), "Chuyển bàn"),
    # Không có trong BRD Matrix; cấu hình nhà hàng, gán Supervisor như quản lý thực đơn.
    Permission.TABLE_LAYOUT_MANAGE: PermissionRule(
        ("SUPERVISOR",), "Quản lý tầng/khu và gán bàn vào khu"
    ),
    # Không có trong BRD Matrix; đi cùng việc mở bàn nên cùng nhóm role.
    Permission.QR_SESSION_MANAGE: PermissionRule(_FLOOR_ROLES, "Cấp và thu hồi mã QR gọi món"),
    # Không có trong BRD Matrix; theo tinh thần "Override Actions" — cần BA/PM xác nhận.
    Permission.MENU_WRITE: PermissionRule(("SUPERVISOR",), "Quản lý thực đơn và nhóm món"),
    # BRD Supervisor: "Monitor all operations"; audit chứa thao tác của mọi nhân viên.
    Permission.AUDIT_READ: PermissionRule(("SUPERVISOR",), "Xem nhật ký, lịch sử phiên bản đơn"),
    # Rollout board Pha 2 "Role Management"; dự án chưa có role Admin riêng.
    Permission.STAFF_MANAGE: PermissionRule(("SUPERVISOR",), "Quản lý tài khoản nhân viên"),
    # Đi cùng "Apply Reward". Có dữ liệu cá nhân nên không mở rộng hơn.
    Permission.CUSTOMER_ACCESS: PermissionRule(
        ("CASHIER", "SUPERVISOR"), "Tra cứu, tạo khách hàng và gắn khách vào đơn"
    ),
    # = "Apply Reward". Bỏ qua điều kiện ưu đãi là "Override Actions", kiểm tra riêng trong API.
    Permission.REWARD_APPLY: PermissionRule(
        ("CASHIER", "SUPERVISOR"), "Xem và áp ưu đãi vào đơn"
    ),
    # Không có trong BRD Matrix; ảnh hưởng tới tiền nên theo "Override Actions".
    Permission.LOYALTY_MANAGE: PermissionRule(
        ("SUPERVISOR",), "Quản lý luật điểm, sửa khách hàng, điều chỉnh điểm"
    ),
}


def permissions_for_role(role: str) -> list[str]:
    return [perm.value for perm, rule in PERMISSION_MATRIX.items() if role in rule.roles]
