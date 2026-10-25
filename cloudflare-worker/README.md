# Cầu nối Telegram → Extension (lên đơn tự động)

Cho phép bấm nút **"Lên đơn tự động"** trên Telegram (kể cả từ điện thoại) để
máy tính đang mở extension tự lên đơn trên nhanh.vn.

## Cách hoạt động

```
Điện thoại bấm nút callback  →  Telegram webhook  →  Cloudflare Worker
     → ghi lệnh {phone} vào KV (hàng đợi)
Extension poll /pull mỗi ~30s →  Worker trả lệnh  →  extension mở vpage
     → runFill (lên đơn)        →  POST /ack        →  Worker xóa lệnh
```

> Lưu ý: máy tính phải **đang bật, Chrome mở, đã đăng nhập vpage.nhanh.vn**.
> Worker chỉ là hàng đợi; việc lên đơn vẫn chạy trong trình duyệt của bạn.

## 1. Cài wrangler & đăng nhập

```bash
npm install -g wrangler
wrangler login
```

## 2. Tạo KV namespace

```bash
cd cloudflare-worker
wrangler kv namespace create ORDERS
```

Dán `id` nhận được vào `wrangler.toml` (thay `DÁN_KV_NAMESPACE_ID_VÀO_ĐÂY`).

## 3. Đặt các biến bí mật

```bash
wrangler secret put BOT_TOKEN      # token bot Telegram (từ @BotFather)
wrangler secret put TG_SECRET      # chuỗi tự đặt, dùng xác thực webhook
wrangler secret put PULL_SECRET    # chuỗi tự đặt, extension dùng khi poll
wrangler secret put ALLOWED_CHAT_IDS   # (tùy chọn) vd: 123456789
```

Gợi ý tạo chuỗi bí mật ngẫu nhiên:

```bash
# PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

## 4. Deploy

```bash
wrangler deploy
```

Ghi lại URL Worker, dạng:
`https://lendon-telegram-bridge.<tài_khoản>.workers.dev`

## 5. Đăng ký webhook Telegram

Gọi 1 lần (thay BOT_TOKEN, WORKER_URL, TG_SECRET):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>/telegram&secret_token=<TG_SECRET>
```

Mở link trên trình duyệt, thấy `{"ok":true,...}` là xong.
Kiểm tra: `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`

## 6. Cấu hình extension

Mở trang Options của extension, mục **"Lên đơn tự động từ Telegram"**:

- Tick **Bật nhận lệnh lên đơn tự động**.
- **Worker URL**: dán URL ở bước 4 (không có `/` cuối).
- **Pull Secret**: dán đúng `PULL_SECRET` ở bước 3.
- Bấm **Kiểm tra kết nối Worker** để xác nhận.
- Lưu cấu hình.

## Kiểm tra endpoint

- `GET /health` → `{ ok: true }`
- `GET /pull` (header `x-pull-secret`) → danh sách lệnh chờ
- `POST /ack` (body `{ id }`) → xóa 1 lệnh

## Bảo mật

- `TG_SECRET` chặn người lạ giả webhook Telegram.
- `PULL_SECRET` chặn người lạ đọc/xóa hàng đợi.
- `ALLOWED_CHAT_IDS` (khuyến nghị) chỉ cho phép chat_id của bạn bấm lệnh.
- Hàng đợi chỉ chứa **số điện thoại**, tự hết hạn sau 1 giờ (TTL).
