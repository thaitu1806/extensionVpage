# Nhanh.vn - DeepSeek Tự Điền Đơn (Chrome Extension)

Extension đọc tin nhắn chat chốt đơn gần nhất, dùng **DeepSeek AI** để trích xuất
thông tin (tên, SĐT, địa chỉ, sản phẩm, phí ship, tổng COD) rồi tự điền vào form
tạo đơn hàng Nhanh.vn (`order/manage/crmadd2`).

## Cài đặt (chế độ Developer)

1. Mở Chrome → `chrome://extensions`.
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** → chọn thư mục chứa extension này.
4. Ghim extension lên thanh công cụ.

## Cấu hình

1. Bấm icon extension → **Cấu hình** (hoặc chuột phải → Options).
2. Dán **API Token DeepSeek** (lấy ở `platform.deepseek.com` → API Keys).
3. Chọn model, số tin nhắn gần nhất cần đọc (mặc định 3).
4. (Tùy chọn) Dán **danh mục sản phẩm chuẩn**, mỗi dòng 1 sản phẩm — AI sẽ
   ánh xạ tên khách nói về tên chuẩn.
5. Bấm **Lưu cấu hình**.

## Sử dụng

1. Mở màn hình tạo đơn Nhanh.vn có khung chat + form.
2. Bấm icon extension → **Tự điền từ Chat**.
3. Extension sẽ:
   - Đọc các tin nhắn gần nhất (nhận biết tin của KHÁCH vs SHOP).
   - **Ưu tiên**: nếu khung chat có khối "xác nhận đơn" (Mã đơn hàng / Tên người
     nhận / Số điện thoại / Địa chỉ / Sản phẩm / Tổng) do CSKH tự động gửi, extension
     parse trực tiếp khối này → chính xác và không tốn API DeepSeek.
   - **Dự phòng**: nếu chưa có khối xác nhận, gọi DeepSeek phân tích 2-3 tin gần nhất.
   - Điền Tên / SĐT / Địa chỉ / Phí ship / Ghi chú, và thử thêm sản phẩm.

## Cấu trúc chat Nhanh.vn mà extension dựa vào

- Mỗi tin: `.c-msg-item` → `.c-msg.left` (KHÁCH) hoặc `.c-msg.right` (SHOP/BizAI/CSKH).
- Nội dung text: `.c-msg-item-text .raw` và `.atm .raw` (bỏ qua `app-post-layout` là
  bài quảng cáo, bỏ sticker/ảnh).
- Khối xác nhận đơn: `.atm.bag.bag-buttons .raw.mb-4`.
- Tên người gửi: `b.n.copy`.

## Lưu ý về việc điền sản phẩm

Form Nhanh.vn chạy Angular. Việc điền text (tên, sđt, địa chỉ) hoạt động ổn định.
Việc **thêm sản phẩm vào bảng** phụ thuộc cấu trúc gợi ý tìm kiếm; selector trong
`content.js` (hàm `findProductSearchInput`, `pickFirstSuggestion`,
`setLastRowQuantity`) có thể cần chỉnh lại cho khớp DOM thực tế của bạn.

Nếu chat và form nằm ở hai frame khác nhau (ví dụ chat ở trang cha, form trong
iframe `#addOrder`), extension vẫn chạy được vì content script được inject vào
**mọi frame** và background tự dò frame nào có chat / frame nào có form.

## Cấu trúc file

- `manifest.json` – khai báo extension (MV3).
- `background.js` – gọi DeepSeek API, điều phối thu thập chat & điền form.
- `content.js` – đọc chat và điền form (chạy trong mọi frame).
- `popup.html/js` – nút Tự điền.
- `options.html/js` – trang cấu hình.

## Xem log để debug

Extension ghi log chi tiết. Có 2 nơi cần mở Console:

**1. Log của background (service worker):**
- Vào `chrome://extensions` → tìm extension → bấm **service worker** (dưới "Inspect views").
- Log có tiền tố `[DS-Fill BG]`: cho biết tab có bao nhiêu frame, mỗi frame url gì,
  frame nào thu được chat, frame nào có form, kết quả điền.

**2. Log của content script (từng frame):**
- Mở trang Nhanh.vn → F12 → tab **Console**.
- Góc trên Console có dropdown chọn **JavaScript context / frame**. Chọn frame
  `crmadd2` (iframe `#addOrder`) để xem log của frame đó.
- Log có tiền tố `[DS-Fill TOP:...]` hoặc `[DS-Fill iframe:...]`: cho biết frame nào,
  tìm thấy tab/ô nhập/sản phẩm hay không, danh sách gợi ý, v.v.

Nếu không thấy click: kiểm tra log BG xem frame `crmadd2` có xuất hiện trong danh sách
frame không, và FILL_FORM gửi tới frame đó trả về gì.
