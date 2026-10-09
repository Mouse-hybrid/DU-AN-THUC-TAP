# ADR 0003: Nền tảng frontend và cách đưa FE lên staging

- Trạng thái: Proposed — BE và FE đã thống nhất 09/10/2026, chờ mentor/Tech Lead xác nhận
- Ngày: 2026-10-09
- Người đề xuất: Backend Developer (Linh) cùng Frontend Developer (Thế Anh), soạn cùng Claude
- Tương ứng: ARC-01 (stack FE), CICD-01/03 (CI cho PR, tự deploy khi merge) trong `Checklist_Quan_Ly_Du_An_POS_28-9`

## Bối cảnh

Figma "NOVA POS — UI/UX Screen System" có 66 màn hình P1, Pha 1 cần 15 màn (POS trên máy
cảm ứng 1440×900, tablet bếp 1280×800) và nhận realtime qua WebSocket. API backend cho cả
15 màn đã có trên staging. Trước ADR này repo chỉ có các trang mock HTML trong
`backend/app/templates` + `static` (FastAPI/Jinja phục vụ), CI/CD chỉ build và deploy backend.

## Quyết định

### Vị trí code
**Thư mục `frontend/` ở gốc repo**, ngang hàng `backend/`. Không đặt trong
`backend/app/templates` + `static`: chỗ đó chỉ hợp với HTML thuần không có bước build, không
dùng được component/TypeScript, và buộc FE phải chạy backend Python mới xem được giao diện.
Các trang mock cũ giữ nguyên để tham khảo, sẽ bị giao diện mới thay ở `/` trên staging.

### Stack
- **React + Vite + TypeScript**, quản lý gói bằng **npm** (commit `package-lock.json`, CI dùng `npm ci`).
- **Node 24 LTS**, ghim bằng `frontend/.nvmrc` và `engines` trong `package.json`.
- Script bắt buộc trong `package.json`: `dev`, `lint`, `typecheck`, `build`. Bản build ra `frontend/dist/`.
- Vite dev server cố định cổng **5173** (`strictPort`), khớp CORS của staging.
- Địa chỉ API đọc từ `import.meta.env.VITE_API_BASE_URL`: khi chạy trên máy trỏ tới
  `http://160.191.47.17/api/v1`; bản build cho staging dùng đường dẫn tương đối `/api/v1`
  (deploy tự đặt). WebSocket: cùng host, đường dẫn `/api/v1/ws?token=<JWT>&channel=…`.

### CI (mỗi PR và mỗi lần push `main`)
Job `frontend` trong `.github/workflows/backend-ci.yml`: `npm ci` → `npm run lint` →
`npm run typecheck` → `npm run build`. Chưa có `frontend/package.json` thì job bỏ qua và vẫn xanh,
để PR chỉ sửa backend không bị chặn.

### Deploy staging (merge vào `main`)
`deploy-staging` chờ cả `docker-build` và `frontend` xanh. `scripts/deploy-staging.sh` build FE
bằng container `node:<bản trong .nvmrc>-alpine` (mặc định 24) với quyền của user runner, chép
`frontend/dist` vào `~/pos-staging-frontend` trên server; nginx mount thư mục này và phục vụ ở `/`.

Phân đường dẫn trong `infra/nginx/staging.conf`:

| Đường dẫn | Đi đâu |
|---|---|
| `/api/v1/ws` | Backend, có header WebSocket, không ghi access log |
| `/api/`, `/docs`, `/redoc`, `/openapi.json`, `/health`, `/ready`, `/static/` | Backend |
| `/assets/*` | File build của FE, cache 30 ngày (tên file có hash) |
| Mọi đường dẫn khác | File FE nếu có, không thì `index.html` (SPA). Chưa có bản build FE thì rơi về backend như trước |

FE và API cùng một địa chỉ trên staging nên trình duyệt không cần CORS ở đó; CORS chỉ dùng khi
FE chạy trên máy (`localhost:5173`) gọi API staging.

### Quy trình merge
FE làm trên nhánh riêng, mở PR vào `main`. Đề xuất bật **branch protection** cho `main` (bắt
buộc qua PR, bắt buộc các check `test`, `docker-build`, `frontend` xanh) và **Allow auto-merge**:
tác giả bấm "Enable auto-merge" một lần, CI xanh (và được duyệt, nếu bật) thì GitHub tự merge
rồi tự deploy. Hai cài đặt này cần quyền admin repo.

## Hệ quả

### Tích cực
- FE bắt đầu code ngay trên máy, không phụ thuộc pipeline; merge là tự lên staging cho QA.
- Một PR có thể sửa cả API lẫn màn hình, cùng review và cùng CI.
- Lỗi lint/kiểu/build của FE bị chặn ở PR, không lên được staging.

### Hạn chế / rủi ro cần theo dõi
- CI xanh chỉ đảm bảo build được, không đảm bảo giao diện đúng Figma — vẫn cần review và QA.
- Khi đang chép bản build mới (vài giây) `/` có thể rơi về trang backend; chấp nhận được trên staging.
- Các trang mock cũ (`/pos`, `/kitchen`, …) bị giao diện FE che khi FE đã deploy.
- Chưa có HTTPS/domain thật (Pha 4).
