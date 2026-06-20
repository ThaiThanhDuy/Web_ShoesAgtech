# server-ShoesAgtech

Nhận dữ liệu chất lượng nước (pH, nhiệt độ, kiềm) từ QGroundControl, lưu vào MySQL, và hiển thị qua web UI.

> Muốn biết chính xác QGC gửi field gì lên server (tên field JSON, cột DB
> tương ứng, cách thêm field mới) → xem `../Shoes_agtech_data_sync.md`.

## Cài đặt

```bash
cd server
npm install
cp .env.example .env
```

Sửa `.env` theo thông tin MySQL của bạn (host, user, password, database).

## Tạo database

```bash
mysql -u root -p < sql/schema.sql
```

## Tạo tài khoản admin (web dashboard)

Tài khoản admin lưu trong bảng `admins` (không còn cấu hình trong `.env`). Mỗi
admin có `admin_key` riêng (tự sinh ngẫu nhiên, dùng để đăng ký board mới):

```bash
npm run create-admin -- admin "mật-khẩu-mạnh-ở-đây"
```

Lệnh in ra `admin_key` — lưu lại, dùng ở bước đăng ký board dưới đây. Chạy lại
lệnh này với cùng username để đổi password/admin_key (tự động update, không tạo trùng).

## Đăng ký board (Cube/Pixhawk)

Mỗi board phải đăng ký trước khi được phép gửi dữ liệu. `device_uid` lấy từ
`Vehicle.vehicleUIDStr` trong QGC (mã phần cứng duy nhất của chip, dạng
`AA:BB:CC:DD:EE:FF:00:11`) — xem trong dialog "Chất lượng nước" (ô "Device UID").

**Cách 1 — qua web dashboard** (không cần SSH vào server):
mở `http://<server>/`, bấm "Đăng ký board", điền Admin key (từ bước tạo admin
trên) + Device UID + username + password, bấm "Đăng ký".

**Cách 2 — CLI trên server**:
```bash
npm run register-device -- "AA:BB:CC:DD:EE:FF:00:11" rover01 "mật-khẩu-cho-board-này"
```

Username/password này nhập vào QGC (dialog "Chất lượng nước") để đồng bộ — QGC tự
gửi kèm `device_uid` thật của board đang kết nối, server so khớp cả 3 (device_uid +
username + password) mới chấp nhận ghi dữ liệu. Nút "Đăng nhập" trong dialog cho
phép kiểm tra khớp trước, không cần có dữ liệu để test.

## Chạy server

```bash
npm start
```

Mặc định chạy ở `http://localhost:3000`. Mở trình duyệt vào địa chỉ đó để xem web UI.

## API

- `POST /api/water-quality/batch` — header `x-username`, `x-password` (phải khớp `device_uid` trong body), body:
  ```json
  { "deviceId": "AA:BB:CC:DD:EE:FF:00:11", "records": [{ "idx": 1, "lat": 10.1, "lon": 106.1, "alt": 5, "ph": 7.5, "temp": 28, "alk": 80, "ts": "2026-06-17T10:00:00Z" }] }
  ```
- `GET /api/water-quality` — trả toàn bộ record (query params tùy chọn: `deviceId`, `from`, `to`)
- `DELETE /api/water-quality/:id` — header `x-username`, `x-password` (bất kỳ board đã đăng ký), xóa 1 record
- `POST /api/water-quality/login` — header `x-username`, `x-password`, body `{ deviceId }` — kiểm tra khớp, không ghi data
- `POST /api/robot/batch` — header `x-username`, `x-password`, body `{ deviceId, records: [{ battery, gpsFix, gpsSats, flightMode, lat, lon, ts }] }` — telemetry robot, QGC tự gửi ngầm định kỳ (không có nút "Đồng bộ" thủ công, xem `DataShoesAgtech.qml`)
- `GET /api/robot` — trả telemetry robot (query params tùy chọn: `deviceId`, `from`, `to`)
- `POST /api/devices/register` — header `x-admin-key`, body `{ deviceUid, username, password }` — đăng ký/cập nhật 1 board
- `GET /api/devices` — danh sách board đã đăng ký (không trả password)

## Deploy lên server thật

Khi có VPS/server thật:
1. Cài Node.js + MySQL trên server đó (hoặc dùng MySQL managed).
2. Copy thư mục `server/` lên (không copy `node_modules/` và `.env`), chạy `npm install`.
3. Tạo `.env` riêng cho server thật, tạo lại database (`mysql -u root -p < sql/schema.sql`), đăng ký lại board.
4. Chạy bền bằng PM2:
   ```bash
   npm install -g pm2
   pm2 start src/index.js --name server-ShoesAgtech
   pm2 save && pm2 startup
   ```
5. Mở port (ví dụ 3000) hoặc đặt sau Nginx reverse proxy với domain/SSL.
6. Trong QGC, mở menu → **"Máy chủ"** → bấm "Sửa", nhập địa chỉ public của server
   này (dạng `http://<ip-hoặc-domain>:<port>/api`, ví dụ `http://203.0.113.10:3000/api`
   hoặc `https://agtech.example.com/api` nếu có Nginx+SSL) → bấm "Kiểm tra & Lưu".
   QGC tự test kết nối (`GET <url>/health`) và chỉ lưu nếu thành công — **không cần
   sửa code/build lại APK** (xem `Shoes_agtech_data_sync.md` ở repo root).
