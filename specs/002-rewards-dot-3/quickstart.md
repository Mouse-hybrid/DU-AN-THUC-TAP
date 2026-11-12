# Quickstart: thử Rewards đợt 3

Cần một luật điểm đang áp dụng (ví dụ 10.000đ = 1 điểm, 1 điểm = 100đ, tối đa 50%, hạn 365 ngày) và một khách có sẵn điểm.

## 1. Hoàn điểm

1. Mở bàn, gọi món tổng 50.000đ, gắn khách có 300 điểm, áp ưu đãi đổi 200 điểm.
2. Thu ngân thu 30.000đ. Khách còn 103 điểm (300 − 200 + 3).
3. Supervisor hoàn 10.000đ. **Kết quả đúng:** điểm vẫn 103.
4. Supervisor hoàn nốt 20.000đ. **Kết quả đúng:**
   - điểm thành 300;
   - sổ điểm có dòng `REVERSAL` +197;
   - ưu đãi của đơn ở trạng thái `REVERSED`.

## 2. Hết hạn điểm

Chạy trên staging:

```bash
docker compose --env-file .env.staging -f infra/compose/compose.staging.yml \
  exec api python scripts/expire_points.py --dry-run
```

- **Lệnh `--dry-run`:** chỉ in số điểm sẽ trừ của từng khách, không ghi gì.
- **Chạy thật:** bỏ `--dry-run`. Chạy lại lần nữa thì không trừ thêm.
- **Chạy tự động:** workflow `expire-points.yml` chạy mỗi ngày lúc 03:00. Chạy tay ở *Actions → Expire loyalty points*.

## 3. Số điện thoại trên QR

| Thử | Kết quả đúng |
|---|---|
| Nhập số của khách đã là thành viên | Trang hiện "Đã ghi nhận 090****567"; thanh toán xong khách được tích điểm |
| Nhập số chưa là thành viên | Trang hiện đúng câu như trên; màn thu ngân thấy nhắc "Khách có nhập số điện thoại" |
| Thu ngân đăng ký khách (xác nhận đồng ý) rồi gắn vào đơn | Nhắc biến mất; thanh toán xong khách được tích điểm |
| Nhập 6 lần trong một phiên | Lần thứ 6 báo nhờ thu ngân hỗ trợ |
| Tìm cách đổi điểm hoặc xem số dư trên QR | Không có chức năng này |
