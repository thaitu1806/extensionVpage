# Cầu nối Telegram → Extension VPage

Cho phép vừa bấm nút **Lên đơn** trên Telegram vừa điều khiển cấu hình extension từ điện thoại bằng lệnh chat.

## Cách hoạt động

```
Telegram command/callback → Cloudflare Worker → Queue → Durable Object → WebSocket → Chrome extension
```

Máy tính vẫn cần bật, Chrome đang chạy, extension đã cài và Worker/WebSocket được cấu hình. Telegram chỉ điều khiển extension đang chạy trên máy tính, không tự thao tác khi máy tắt.

## Lệnh Telegram

Gửi các lệnh sau trong chat với bot:

| Lệnh | Tác dụng |
|---|---|
| `/status` | Xem trạng thái cấu hình extension hiện tại |
| `/auto_on` | Bật tự lên đơn ngay sau khi gửi thông báo Telegram |
| `/auto_off` | Tắt tự lên đơn khi gửi thông báo; vẫn giữ thông báo và nút lên đơn thủ công |
| `/orders_on` | Bật nhận lệnh/nút Lên đơn từ Telegram |
| `/orders_off` | Tắt nhận lệnh lên đơn từ Telegram; kênh điều khiển vẫn kết nối để bật lại từ xa |
| `/save_on` | Bật tự động bấm Lưu/gửi đơn (**có thể tạo đơn thật**) |
| `/save_off` | Tắt tự động lưu/gửi; cần kiểm tra và lưu thủ công |
| `/notify_on` | Bật quét/thông báo Telegram |
| `/notify_off` | Tắt quét/thông báo Telegram |
| `/help` | Xem hướng dẫn lệnh |

Các lệnh cập nhật cấu hình sẽ được Worker đưa vào Queue; extension trả tin nhắn xác nhận sau khi nhận và áp dụng cấu hình. Nếu máy/Chrome/extension đang tắt hoặc mất kết nối, lệnh có thể chờ đến khi extension kết nối lại.

**Lưu ý an toàn:** `/auto_off` chỉ tắt tự động lên đơn sau khi gửi thông báo. Nó không tự tắt `autoSubmitOrder`; dùng riêng `/save_off` để ngắt tự động lưu/gửi đơn. Chỉ dùng `/save_on` sau khi đã kiểm thử quy trình.

## 1. Cài Wrangler

```bash
npm install -g wrangler
wrangler login
cd cloudflare-worker
```

## 2. Queue và Durable Object

Cấu hình `wrangler.toml` hiện dùng Queue `vpage-order-commands` và Durable Object `CommandHub`. Nếu Queue chưa được tạo trong tài khoản Cloudflare:

```bash
npx wrangler queues create vpage-order-commands
```

Đảm bảo binding `ORDERS_QUEUE`, consumer Queue, Durable Object `COMMANDS` và migration trong `wrangler.toml` tồn tại trước khi deploy. Không cần tạo KV namespace cho bản Queue Push.

## 3. Cấu hình secrets

Đặt secrets cho Worker (giữ nguyên giá trị hiện có nếu đã cấu hình):

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TG_SECRET
npx wrangler secret put PULL_SECRET
npx wrangler secret put ALLOWED_CHAT_IDS
```

- `BOT_TOKEN`: token bot Telegram từ `@BotFather`.
- `TG_SECRET`: chuỗi bí mật xác thực webhook Telegram.
- `PULL_SECRET`: secret kết nối WebSocket và endpoint báo trạng thái; phải trùng secret trong extension.
- `ALLOWED_CHAT_IDS`: **bắt buộc để dùng các lệnh điều khiển**, chỉ điền Chat ID cá nhân/nhóm được phép. Có thể là danh sách ID cách nhau bằng dấu phẩy. Nếu chưa cấu hình, Worker từ chối các lệnh điều khiển (trừ `/help`).

## 4. Deploy Worker

Từ thư mục `cloudflare-worker`:

```bash
npx wrangler deploy
```

Lưu URL Worker, ví dụ `https://lendon-telegram-bridge.<tài_khoản>.workers.dev`.

## 5. Đăng ký webhook Telegram

Nếu webhook đã được đăng ký tới đúng URL Worker và `TG_SECRET`, không cần đăng ký lại. Nếu chưa, gọi một lần (thay các giá trị thật):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>/telegram&secret_token=<TG_SECRET>
```

Kiểm tra webhook bằng `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`. Không chia sẻ URL chứa token bot.

## 6. Cập nhật extension

1. Mở `chrome://extensions`.
2. Bấm **Reload** extension Nhanh.vn - DeepSeek Tự Điền Đơn để nhận code mới.
3. Mở **Cấu hình** và tại mục **Lên đơn tự động từ Telegram**:
   - Bật **Bật nhận lệnh lên đơn tự động** để cho phép nút lên đơn từ Telegram.
   - Điền **Cloudflare Worker URL**.
   - Điền **Secret kết nối** đúng bằng `PULL_SECRET`.
   - Bấm **Kiểm tra kết nối Worker**, sau đó **Lưu cấu hình**.
4. Đảm bảo chat ID Telegram của bạn nằm trong `ALLOWED_CHAT_IDS`.
5. Gửi `/help`, rồi `/status` trong chat bot để kiểm tra.

Kênh WebSocket tiếp tục kết nối ngay cả khi `/orders_off` được dùng, nhằm cho phép bật lại từ xa. Nếu thay Worker URL hoặc secret, lưu cấu hình lại.

## Endpoint

- `GET /health`: kiểm tra Worker, trả mode `queue-push`.
- `POST /telegram`: webhook Telegram.
- `POST /ack`: extension xác nhận đã xử lý lệnh.
- `POST /report`: extension gửi trạng thái/phản hồi về Telegram, được bảo vệ bằng `PULL_SECRET`.
- `GET /pull`: đã tắt; không dùng polling KV.

## Bảo mật

- `TG_SECRET` bảo vệ webhook Telegram.
- `PULL_SECRET` bảo vệ WebSocket, ACK và báo cáo trạng thái.
- `ALLOWED_CHAT_IDS` giới hạn người được điều khiển bot.
- Không gửi token bot hoặc các secret lên nhóm công khai.
