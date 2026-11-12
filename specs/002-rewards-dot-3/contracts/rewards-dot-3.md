# Contract: Rewards đợt 3

Hợp đồng cho FE và QA. Sau khi code, `docs/api/openapi.json` là nguồn chính thức.

## 1. Khách nhập số điện thoại — `POST /api/v1/public/qr/{token}/member`

- Công khai, không cần đăng nhập. Bắt buộc header `Idempotency-Key`, như các API ghi QR khác.

```json
{ "phone": "0901234567" }
```

**200** — giống hệt nhau cho số đã là thành viên và số chưa là thành viên:

```json
{ "status": "RECEIVED", "phone_masked": "090****567" }
```

| Mã | Khi nào |
|---|---|
| 401 | Mã QR không đúng hoặc đã bị thu hồi |
| 410 | Mã QR đã hết hạn hoặc phiên bàn đã đóng |
| 422 | Số điện thoại sai định dạng (không tính vào số lần thử) |
| 429 | `"Đã nhập quá số lần cho phép, vui lòng nhờ thu ngân hỗ trợ"` |

## 2. Thu ngân xem số chờ — `GET /api/v1/orders/{order_id}/pending-member`

- Quyền `CUSTOMER_ACCESS`.

**200**:

```json
{ "phone": "0901234567", "member_customer_id": null }
```

- Không có số chờ: `{ "phone": null, "member_customer_id": null }`.
- Số đã là thành viên nhưng chưa gắn được vì đơn đã có khách khác: `member_customer_id` là id của thành viên đó.

Sau đó thu ngân dùng các API sẵn có:
- `POST /customers` (xác nhận đồng ý) để đăng ký khách mới;
- `POST /orders/{id}/customer` để gắn khách. Gắn xong thì số chờ bị xóa.

## 3. Chi tiết đơn — thay đổi nhỏ

`GET /orders/{id}` và `GET /tables/{id}` có thêm `has_pending_member: bool`. Trường này để màn thu ngân hiện nhắc "Khách có nhập số điện thoại", không chứa số.

## 4. Hoàn tiền — không đổi API

Khi `POST /payments/{id}/refunds` làm đơn được hoàn hết, response không đổi, nhưng có thêm hai việc:
- sổ điểm của khách có thêm dòng `REVERSAL`;
- `applied_reward.status` của đơn thành `REVERSED`.

## Audit

| Action | Ngoại lệ | Khi nào |
|---|---|---|
| `POINTS_REVERSED` | Có | Đảo điểm khi hoàn hết đơn |
| `POINTS_REVERSAL_SHORTFALL` | Có | Không thu lại đủ điểm tích vì số dư không đủ |
| `POINTS_EXPIRED` | Không | Mỗi khách bị trừ điểm hết hạn; payload gồm số điểm và ngày hạn |
| `QR_MEMBER_LINKED` | Không | Gắn thành viên vào đơn từ QR; `staff_id` null |
| `QR_MEMBER_PENDING` | Không | Giữ số chờ thu ngân; payload chỉ có số đã che |
