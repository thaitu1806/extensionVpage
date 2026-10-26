# Deploy Queue Push

Telegram webhook -> Cloudflare Queue -> Queue consumer -> Durable Object lưu lệnh chờ -> WebSocket -> Chrome extension. Không còn dùng KV.list/get hoặc alarm ds-pull.

## 1. Tạo Queue và deploy
Trong thư mục cloudflare-worker:
```bash
npx wrangler queues create vpage-order-commands
npx wrangler deploy
```
Nếu queue đã tồn tại, bỏ qua lệnh create. Kiểm tra trạng thái migration Durable Object nếu đây không phải lần deploy đầu tiên.

## 2. Secrets
Giữ nguyên secrets đang dùng trên Cloudflare: BOT_TOKEN, TG_SECRET, PULL_SECRET; ALLOWED_CHAT_IDS là tùy chọn. Nếu thiếu, đặt bằng `npx wrangler secret put <NAME>`. PULL_SECRET phải trùng giá trị trong Options của extension.

## 3. Extension
1. Cập nhật/reload extension từ repo.
2. Trong Options, bật “Lên đơn tự động từ Telegram”.
3. Nhập Worker URL và cùng PULL_SECRET, bấm Lưu cấu hình.
4. Mở Chrome và đăng nhập Vpage. Extension sẽ kết nối WebSocket và nhận lệnh push.

## 4. Kiểm tra
GET /health phải trả `mode: "queue-push"`. Bấm nút “🧾 Lên đơn” trên Telegram; log service worker sẽ ghi “Push: nhận lệnh”. Nếu extension offline, Durable Object giữ lệnh đến khi extension kết nối và ACK.

## Lưu ý
Queue có thể retry; lệnh được lưu theo ID trong Durable Object. Extension lưu tối đa 500 ID đã xử lý để tránh thao tác trùng. Lệnh lỗi vẫn ACK sau lần thử và cần xem log thủ công.
