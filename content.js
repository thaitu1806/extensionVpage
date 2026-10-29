// Content script chạy ở MỌI frame của trang Nhanh.vn.
//  - COLLECT_MESSAGES: tìm & trả về N tin nhắn chat gần nhất (kèm người gửi, vai trò)
//                      và khối "xác nhận đơn" nếu có.
//  - FILL_FORM: điền dữ liệu đã trích xuất vào form đơn hàng.

// GUARD chống nạp trùng: manifest inject sẵn (all_frames) + background có thể
// executeScript lại -> nạp 2 lần gây "Identifier already declared". Chặn tại đây.
if (window.__dsFillContentLoaded) {
  console.log("[DS-Fill] content.js đã nạp trước đó -> bỏ qua lần nạp này.");
} else {
  window.__dsFillContentLoaded = true;

/* ============== LOG ============== */

const FRAME_TAG = (() => {
  const isTop = window.top === window.self;
  let url = "";
  try { url = location.href; } catch (_) { url = "(cross-origin)"; }
  const short = url.replace(/^https?:\/\//, "").slice(0, 60);
  return `[DS-Fill ${isTop ? "TOP" : "iframe"}:${short}]`;
})();

function log(...args) {
  console.log(FRAME_TAG, ...args);
}

log("content script đã nạp.");

/* ============== TỰ TIẾP TỤC BUSINESS AGENT ============== */
// Khi mở box chat, nếu Vpage hiển thị nút "Tiếp tục" của BizAI/Business Agent,
// tự click một lần để Agent tiếp tục trả lời. Theo dõi DOM vì nút có thể xuất hiện
// trễ sau khi hội thoại được tải.
let _bizAiContinueButton = null;
let _bizAiAutoContinueEnabled = true;
chrome.storage.local.get({ bizAiAutoContinue: true }, (cfg) => {
  _bizAiAutoContinueEnabled = cfg.bizAiAutoContinue !== false;
  if (_bizAiAutoContinueEnabled) clickBizAiContinueIfPresent();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.bizAiAutoContinue) return;
  _bizAiAutoContinueEnabled = changes.bizAiAutoContinue.newValue !== false;
  if (!_bizAiAutoContinueEnabled) _bizAiContinueButton = null;
  else clickBizAiContinueIfPresent();
});

function clickBizAiContinueIfPresent() {
  if (!_bizAiAutoContinueEnabled) return;
  const buttons = Array.from(document.querySelectorAll(".btn-bizai-continue"))
    .filter((el) => {
      const text = textOf(el);
      return el.isConnected
        && el.getClientRects().length > 0
        && /tiếp tục/i.test(text);
    });

  const button = buttons[0] || null;
  if (!button) {
    _bizAiContinueButton = null;
    return;
  }
  // Không click liên tục khi Angular chưa kịp ẩn/cập nhật nút sau lần click.
  if (_bizAiContinueButton === button) return;

  _bizAiContinueButton = button;
  log('BizAI: phát hiện nút "Tiếp tục", tự click để Agent tiếp tục trả lời.');
  button.click();
}

const _bizAiContinueObserver = new MutationObserver(() => clickBizAiContinueIfPresent());
_bizAiContinueObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true
});
// Kiểm tra định kỳ để nhận biết trường hợp nút được tái sử dụng khi chuyển box.
setInterval(clickBizAiContinueIfPresent, 800);
clickBizAiContinueIfPresent();

/* ============== NẠP SCRIPT VÀO MAIN WORLD (để thao tác AutoNumeric) ============== */

let injectReady = false;
(function injectMainWorld() {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.onload = () => { injectReady = true; s.remove(); log("inject.js đã nạp."); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    log("Không nạp được inject.js:", e.message);
  }
})();

let _dsSeq = 0;
const _dsPending = new Map();
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || msg.source !== "dsfill-inject" || msg.type !== "SET_NUMERIC_RESULT") return;
  const cb = _dsPending.get(msg.id);
  if (cb) { _dsPending.delete(msg.id); cb(msg); }
});

// Nhờ inject (main world) set giá trị ô numeric. Trả {ok, value}.
function setNumericViaInject(el, value, timeout = 1500) {
  return new Promise((resolve) => {
    if (!injectReady) { resolve({ ok: false, reason: "inject-not-ready" }); return; }
    const marker = "dsfill-" + (++_dsSeq);
    el.setAttribute("data-dsfill", marker);
    const id = marker;
    const timer = setTimeout(() => {
      _dsPending.delete(id);
      el.removeAttribute("data-dsfill");
      resolve({ ok: false, reason: "timeout" });
    }, timeout);
    _dsPending.set(id, (res) => {
      clearTimeout(timer);
      el.removeAttribute("data-dsfill");
      resolve(res);
    });
    window.postMessage({ source: "dsfill-content", type: "SET_NUMERIC", id, marker, value }, "*");
  });
}

/* ============== TIỆN ÍCH ============== */

function textOf(el) {
  return (el?.innerText || el?.textContent || "").replace(/\u00a0/g, " ").trim();
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

function fireFocusBlur(el) {
  el.dispatchEvent(new Event("focus", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ô input đã có giá trị thực sự (khác rỗng/khoảng trắng/0 placeholder) chưa?
function hasValue(el) {
  if (!el) return false;
  const v = (el.value || "").trim();
  return v.length > 0;
}

/* ============== ĐỌC TIN NHẮN CHAT ============== */

// Chọn text thuần của 1 tin nhắn (bỏ nội dung bài quảng cáo, nút, ảnh).
function extractItemText(item) {
  const parts = [];

  // Các bong bóng text thường: .c-msg-item-text .raw (nhưng KHÔNG nằm trong app-post-layout)
  item.querySelectorAll(".c-msg-item-text .raw").forEach((raw) => {
    if (raw.closest("app-post-layout")) return;
    const t = textOf(raw);
    if (t) parts.push(t);
  });

  // Khối xác nhận đơn / nút: .atm .raw (ví dụ "Em gửi đơn cho mình ạ: Mã đơn hàng...")
  item.querySelectorAll(".atm .raw").forEach((raw) => {
    if (raw.closest("app-post-layout")) return;
    const t = textOf(raw);
    if (t && !parts.includes(t)) parts.push(t);
  });

  return parts.join("\n").trim();
}

// Trả về danh sách {sender, role, text} theo thứ tự thời gian (cũ -> mới).
function readAllMessages() {
  const items = Array.from(document.querySelectorAll(".c-msg-item"));
  const result = [];

  for (const item of items) {
    const bubble = item.querySelector(".c-msg");
    if (!bubble) continue;

    const role = bubble.classList.contains("right") ? "shop" : "customer";
    const sender = textOf(item.querySelector("b.n.copy")) || "";
    const text = extractItemText(item);

    if (!text) continue; // bỏ sticker/ảnh thuần

    // Bỏ các tin hệ thống gây nhiễu.
    if (/^You took over this chat/i.test(text)) continue;
    if (/^Khách nhắn tin từ quảng cáo/i.test(text)) continue;

    result.push({ sender, role, text });
  }
  return result;
}

// Một đoạn text có phải khối "xác nhận đơn" không?
// Nhận 3 format:
//  - "[XÁC NHẬN ĐƠN HÀNG ...]" (có SĐT + Sản phẩm)
//  - "Em gửi đơn...: Mã đơn hàng ... Số điện thoại ..."
//  - Khối tóm tắt của "Business Agent": "Tên người nhận: ... Số điện thoại: ...
//    Sản Phẩm: N x ..." (KHÔNG có "XÁC NHẬN ĐƠN HÀNG" / "Mã đơn hàng").
function isOrderConfirmation(t) {
  if (!t) return false;
  if (/XÁC NHẬN ĐƠN HÀNG/i.test(t) && /(Số điện thoại|Điện thoại)/i.test(t)) return true;
  if (/Mã đơn hàng/i.test(t) && /(Số điện thoại|Điện thoại)/i.test(t)) return true;
  // Khối tóm tắt Business Agent: cần có SĐT + nhãn "Sản phẩm" + ít nhất 1 dòng
  // "N x ...". Đây là khối chốt đơn chính thức, phải được quét để lấy ĐÚNG đơn
  // chốt GẦN NHẤT (quét từ dưới lên).
  if (/(Số điện thoại|Điện thoại)/i.test(t) &&
      /Sản ?phẩm\s*:/i.test(t) &&
      /\d+\s*x\s*\S/i.test(t)) return true;
  return false;
}

// Tìm tin "xác nhận đơn" GẦN NHẤT.
function findOrderConfirmation(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isOrderConfirmation(messages[i].text)) return messages[i].text;
  }
  return "";
}

// Tìm tin "xác nhận đơn" do CHÍNH MÌNH (SHOP) gửi, CHỈ xét trong N tin GẦN NHẤT
// (từ dưới lên). Dùng cho thông báo Telegram: chỉ báo khi 1 trong N tin cuối
// bên SHOP đúng định dạng khối đơn hàng. Trả về text đầy đủ hoặc "".
function findShopOrderMessage(messages, lastN = 3) {
  // Chỉ lấy N tin cuối cùng của hội thoại.
  const recent = messages.slice(-lastN);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.role !== "shop" || !isOrderConfirmation(m.text)) continue;
    // ĐÃ LÊN ĐƠN: khối có "Theo dõi vận chuyển" (mã vận đơn) -> bỏ qua, không báo.
    if (/Theo dõi vận chuyển/i.test(m.text)) continue;
    return m.text;
  }
  return "";
}

function collectMessages(msgCount) {
  const all = readAllMessages();
  if (!all.length) return { messages: [], orderConfirmation: "" };

  const recent = all.slice(-msgCount).map((m) => `(${m.role === "shop" ? "SHOP" : "KHÁCH"}) ${m.sender}: ${m.text}`);
  return {
    messages: recent,
    orderConfirmation: findOrderConfirmation(all)
  };
}

/* ============== ĐIỀN FORM ĐƠN HÀNG ============== */

function findByPlaceholder(...keywords) {
  const inputs = Array.from(document.querySelectorAll("input, textarea"));
  for (const kw of keywords) {
    const low = kw.toLowerCase();
    const hit = inputs.find((el) => (el.placeholder || "").toLowerCase().includes(low));
    if (hit) return hit;
  }
  return null;
}

// CHỈ coi là có form đơn hàng khi thấy component đặc trưng của màn tạo đơn (crmadd).
// Không dựa vào placeholder chung chung vì trang chat cũng có ô tên/điện thoại.
function hasOrderForm() {
  return !!document.querySelector(
    "app-crmadd-v2, app-crmadd-new, app-customer-crm-component, app-product-crm-component"
  );
}

// Frame này có phải là iframe tạo đơn (crmadd) không?
function isOrderFrame() {
  let href = "";
  try { href = location.href; } catch (_) {}
  return /crmadd/i.test(href) || hasOrderForm();
}

// Click riêng tab điều hướng "Đơn hàng" dạng Angular Material tab (mat-tab-label / role=tab).
// Dùng khớp CHÍNH XÁC text để không nhầm với các mục menu khác.
function clickOrderTabStrict() {
  const tabs = Array.from(document.querySelectorAll(".mat-tab-label, [role='tab']"));
  for (const el of tabs) {
    const content = el.querySelector(".mat-tab-label-content") || el;
    if (textOf(content).toLowerCase() === "đơn hàng") {
      const already = el.getAttribute("aria-selected") === "true"
        || el.classList.contains("mat-tab-label-active");
      log(`clickOrderTabStrict: thấy tab 'Đơn hàng', active=${already}`);
      if (!already) {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.click();
        log("clickOrderTabStrict: đã click.");
      }
      return true;
    }
  }
  log("clickOrderTabStrict: không thấy tab 'Đơn hàng' (mat-tab) ở frame này.");
  return false;
}

// Chờ tới khi form đơn hàng xuất hiện (tối đa ~timeout ms).
async function waitForOrderForm(timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (hasOrderForm()) return true;
    await sleep(200);
  }
  return hasOrderForm();
}

// Chờ nút Lưu được enable sau khi Vpage tải xong dữ liệu (đặc biệt hãng vận chuyển).
async function clickSaveButton(timeout = 45000) {
  const started = Date.now();
  let lastState = "";
  while (Date.now() - started < timeout) {
    const candidates = Array.from(document.querySelectorAll(
      "button.btn-success, button, [role='button'], input[type='button'], input[type='submit']"
    )).filter((el) => el.offsetParent !== null);
    const button = candidates.find((el) => {
      const label = (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim();
      return /(?:^|\s)(?:\(F9\)\s*)?Lưu(?:\s|$)/i.test(label) || /\(F9\)\s*Lưu/i.test(label);
    });
    if (button) {
      const disabled = !!button.disabled
        || button.getAttribute("aria-disabled") === "true"
        || button.classList.contains("disabled");
      const state = disabled ? "disabled" : "enabled";
      if (state !== lastState) {
        log(`Webhook auto-save: nút Lưu đang ${state}; chờ dữ liệu form/hãng vận chuyển...`);
        lastState = state;
      }
      if (!disabled) {
        log("Webhook auto-save: click nút Lưu:", (button.innerText || button.textContent || "").trim());
        button.click();
        log("Webhook auto-save: đã click Lưu; chờ đúng 3 giây rồi kết thúc lên đơn tự động.");
        await sleep(3000);
        return true;
      }
    } else if (lastState !== "missing") {
      log("Webhook auto-save: chưa thấy nút Lưu; tiếp tục chờ form tải...");
      lastState = "missing";
    }
    await sleep(300);
  }
  log(`Webhook auto-save: nút Lưu không enable sau ${timeout / 1000} giây; hủy đóng như thành công.`);
  return false;
}

async function fillForm(data) {
  log("FILL_FORM nhận dữ liệu:", JSON.stringify(data));

  // Chỉ xử lý ở frame tạo đơn. Trang chat sẽ bị bỏ qua để không điền nhầm.
  if (!isOrderFrame()) {
    log("KẾT: frame này KHÔNG phải frame tạo đơn -> bỏ qua.");
    return { filled: false, info: "Không phải frame tạo đơn." };
  }

  // Chờ form render (phòng khi iframe vừa được hiển thị).
  if (!hasOrderForm()) {
    log("Form chưa sẵn sàng -> chờ render...");
    await waitForOrderForm(6000);
  }

  if (!hasOrderForm()) {
    log("KẾT: frame này không có form đơn hàng.");
    return { filled: false, info: "Frame tạo đơn nhưng form chưa render." };
  }
  // Mặc định KHÔNG bật "Tự vận chuyển": chỉ bật khi khách yêu cầu.
  // Ép về trạng thái bỏ chọn mỗi lần tự điền đơn để tránh kế thừa trạng thái cũ của form.
  const transformerCheckbox = document.querySelector('#useTransformer[type="checkbox"]');
  if (transformerCheckbox) {
    if (transformerCheckbox.checked) {
      transformerCheckbox.checked = false;
      transformerCheckbox.dispatchEvent(new Event("input", { bubbles: true }));
      transformerCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
      log('Mặc định bỏ chọn "Tự vận chuyển" (chỉ bật khi khách yêu cầu).');
    } else {
      log('Ô "Tự vận chuyển" đã bỏ chọn.');
    }
  } else {
    log('Không tìm thấy checkbox #useTransformer; không thể đặt mặc định Tự vận chuyển.');
  }

  log("Form đơn hàng đã sẵn sàng. Chờ API nạp dữ liệu khách...");
  // Chờ thêm để API load thông tin khách (tên/sđt/địa chỉ) xong,
  // tránh đọc nhầm ô trống rồi điền đè.
  await sleep(1500);

  const done = [];

  if (data.name) {
    const el = findByPlaceholder("Tên");
    log("Tìm ô 'Tên':", el ? "OK" : "KHÔNG THẤY");
    if (el && hasValue(el)) {
      log("-> ô 'Tên' đã có giá trị, BỎ QUA.");
    } else if (el) {
      setNativeValue(el, data.name); fireFocusBlur(el); done.push("tên");
    }
  }
  if (data.phone) {
    const el = findByPlaceholder("Điện thoại", "Số điện thoại", "SĐT");
    log("Tìm ô 'Điện thoại':", el ? "OK" : "KHÔNG THẤY");
    if (el && hasValue(el)) {
      log("-> ô 'Điện thoại' đã có giá trị, BỎ QUA.");
    } else if (el) {
      setNativeValue(el, String(data.phone)); fireFocusBlur(el); done.push("sđt");
    }
  }
  // Địa chỉ hành chính (Tỉnh/Huyện/Xã) - ô app-location-danymic, cần chọn từ gợi ý.
  if (data.addressRegion) {
    const regionEl = findAddressRegionInput();
    if (regionEl && hasValue(regionEl)) {
      log("-> ô địa chỉ hành chính đã có giá trị, BỎ QUA.");
    } else {
      const okRegion = await fillAddressRegion(data.addressRegion, data.addressRegion2);
      log("Điền địa chỉ hành chính:", okRegion ? "OK" : "chưa chọn được");
      if (okRegion) done.push("tỉnh/xã");
    }
  }

  // Địa chỉ chi tiết (số nhà/đường) - ô app-location-autocomplete, là text thường.
  // Nếu địa chỉ đang có khác với địa chỉ lấy từ tin nhắn thì cập nhật lại;
  // chỉ bỏ qua khi hai giá trị sau trim giống nhau.
  if (data.address) {
    const el = findAddressDetailInput();
    log("Tìm ô 'Địa chỉ chi tiết':", el ? "OK" : "KHÔNG THẤY");
    if (el) {
      const currentAddress = (el.value || "").trim();
      const incomingAddress = String(data.address).trim();
      if (currentAddress === incomingAddress) {
        log("-> ô 'Địa chỉ chi tiết' đã đúng giá trị, BỎ QUA.");
      } else {
        log(`-> địa chỉ chi tiết thay đổi: hiện tại="${currentAddress}", mới="${incomingAddress}" -> cập nhật.`);
        setNativeValue(el, incomingAddress);
        fireFocusBlur(el);
        done.push("địa chỉ");
      }
    }
  }
  if (data.note) {
    const el = findByPlaceholder("Ghi chú khách hàng", "Ghi chú");
    if (el) { setNativeValue(el, data.note); fireFocusBlur(el); done.push("ghi chú"); }
  }

  // Sản phẩm (phải thêm TRƯỚC để hệ thống có cân nặng -> tính được hãng vận chuyển).
  let productInfo = "";
  if (Array.isArray(data.products) && data.products.length) {
    log(`Bắt đầu thêm ${data.products.length} sản phẩm...`);
    const added = await addProducts(data.products);
    productInfo = ` | SP thêm: ${added}/${data.products.length}`;
    log(`Kết quả thêm sản phẩm: ${added}/${data.products.length}`);
  }

  // THỨ TỰ webhook: Sản phẩm -> Mã KM -> Chiết khấu -> chờ 4s
  // -> Phí ship -> chờ 4s -> chọn trạng thái và tự động Lưu.

  // 1) Mã khuyến mại HVC (theo địa chỉ HCM/ngoại tỉnh).
  if (data.promoCode) {
    const okPromo = await selectPromoCode(data.promoCode);
    log(`-> chọn mã KM "${data.promoCode}" = ${okPromo}`);
    if (okPromo) done.push("mã KM");
  }

  // 2) Chiết khấu trước phí ship theo thứ tự yêu cầu.
  const discount = computeDiscount(data);
  {
    const productsTotal = (data.products || []).reduce(
      (s, p) => s + ((Number(p.overridePrice) > 0 ? Number(p.overridePrice) : (Number(p.price) || 0))
        * (Number(p.quantity) || 1)), 0);
    log(`Chiết khấu: tổngHàngTheoGiáChốt=${productsTotal} + ship=${Number(data.shippingFee) || 0}`
      + ` - COD=${Number(data.totalCOD) || 0} = ${discount}`
      + (Number(data.discount) ? ` (discount gốc=${data.discount})` : ""));
  }

  if (discount > 0) {
    const unitCash = ensureDiscountUnitCash();
    log("Đơn vị chiết khấu tiền mặt ($) sẵn sàng =", unitCash);
    await sleep(500);

    let el = findDiscountInput();
    log("Tìm ô 'Chiết khấu':", el ? "OK" : "KHÔNG THẤY");
    if (el) {
      let okDc = await setNumericByPaste(el, discount);
      await sleep(700);
      el = findDiscountInput();
      let actual = el ? readNumber(el.value) : NaN;
      log(`Xác minh chiết khấu: mong muốn=${discount}, thực tế=${actual}`);

      if (actual !== Number(discount) && el) {
        log("Chiết khấu chưa đúng; thử nhập lại một lần.");
        okDc = await setNumericByPaste(el, discount);
        await sleep(900);
        el = findDiscountInput();
        actual = el ? readNumber(el.value) : NaN;
        log(`Xác minh chiết khấu lần 2: mong muốn=${discount}, thực tế=${actual}`);
      }

      const verified = actual === Number(discount);
      log(`-> set chiết khấu ${discount}: thao tác=${okDc}, xác minh cuối=${verified}`);
      if (verified) done.push("chiết khấu");
      else log("CẢNH BÁO: ô Chiết khấu không giữ được giá trị mong muốn; cần kiểm tra form trước khi lưu.");
    }
  } else {
    log("Chiết khấu bằng 0 hoặc không có dữ liệu; bỏ qua nhập chiết khấu.");
  }

  // Chờ 4 giây để form nhận/commit chiết khấu trước khi thay đổi phí ship.
  log("Webhook: chờ 4 giây sau khi nhập chiết khấu trước khi nhập phí ship...");
  await sleep(4000);

  // 3) Phí ship: CHỈ set sau khi hãng vận chuyển (carrier) đã load.
  if (data.shippingFee !== undefined && data.shippingFee !== null && data.shippingFee !== "") {
    log("Chờ hãng vận chuyển (carrier) load...");
    const carrierReady = await waitForCarrier(8000);
    log("Carrier sẵn sàng =", carrierReady);
    const el = findShippingFeeInput();
    log("Tìm ô 'Phí ship':", el ? "OK" : "KHÔNG THẤY");
    if (el && carrierReady) {
      const okFee = await setNumericByPaste(el, data.shippingFee);
      log(`-> set phí ship ${data.shippingFee} = ${okFee}`);
      if (okFee) done.push("phí ship");
    } else if (!carrierReady) {
      log("-> carrier chưa load -> BỎ QUA phí ship (để hệ thống tự tính).");
    }
  }

  // Chờ thêm 4 giây sau khi nhập phí ship để mọi tính toán hoàn tất trước khi Lưu.
  log("Webhook: chờ 4 giây sau khi nhập phí ship trước khi tiếp tục/lưu đơn...");
  await sleep(4000);

  // Webhook lấy trạng thái từ cấu hình; mặc định "Mới" để kiểm thử an toàn.
  if (data.mode === "webhook" || data.mode === "test") {
    const cfg = await chrome.storage.local.get({ autoOrderStatus: "Mới" });
    // Test thủ công luôn chọn "Mới", không bao giờ tự lưu.
    const requestedStatus = data.mode === "test" ? "Mới" : (cfg.autoOrderStatus === "Đã xác nhận" ? "Đã xác nhận" : "Mới");
    const okStatus = setOrderStatus(requestedStatus);
    log(`-> ${data.mode}: chọn trạng thái '${requestedStatus}' = ${okStatus}`);
    if (okStatus) done.push(`trạng thái ${requestedStatus}`);
    if (!okStatus) throw new Error(`${data.mode}: không chọn được trạng thái '${requestedStatus}'; không lưu đơn.`);

    const cfgSubmit = await chrome.storage.local.get({ autoSubmitOrder: false });
    if (data.mode === "test") {
      log("Manual test: đã điền form nhưng KHÔNG bấm Lưu.");
      done.push("test — chưa lưu");
    } else if (cfgSubmit.autoSubmitOrder) {
      const saved = await clickSaveButton(45000);
      if (!saved) throw new Error("Webhook: không tìm thấy nút Lưu; đơn chưa được lưu.");
      done.push("lưu");
      // clickSaveButton đã chờ 3 giây sau khi click Lưu trước khi cho phép đóng tab.    } else {
      log("Webhook: chế độ kiểm thử — đã điền form nhưng KHÔNG bấm Lưu; giữ tab mở để kiểm tra.");
      done.push("chưa lưu (chế độ kiểm thử)");
    }
  } else {
    const okStatus = setOrderStatus("Đã xác nhận");
    log(`-> chọn trạng thái 'Đã xác nhận' = ${okStatus}`);
    if (okStatus) done.push("trạng thái");
  }

  log("KẾT: đã điền:", done.join(", "), productInfo);
  return {
    filled: done.length > 0 || productInfo !== "",
    info: "Đã điền: " + (done.join(", ") || "(trống)") + productInfo,
    reviewRequired: data.mode === "webhook" && !((await chrome.storage.local.get({ autoSubmitOrder: false })).autoSubmitOrder),
    submitted: data.mode === "webhook" && !!((await chrome.storage.local.get({ autoSubmitOrder: false })).autoSubmitOrder)
  };
}

// Tính chiết khấu theo giá chốt thực tế, kể cả khi khác giá catalog.
// totalCOD là tổng cuối đã gồm phí ship:
// chiết khấu = tổng tiền hàng theo giá chốt + phí ship - COD.
// Nếu giá trích từ đơn khác catalog, dùng overridePrice (giá sẽ được cập nhật trên dòng sản phẩm).

function computeDiscount(data) {
  const productsTotal = (data.products || []).reduce((s, p) => {
    // overridePrice là giá chốt cần ghi đè lên catalog khi hai giá khác nhau.
    const price = Number(p.overridePrice) > 0
      ? Number(p.overridePrice)
      : (Number(p.price) || 0);
    const qty = Number(p.quantity) || 1;
    return s + price * qty;
  }, 0);

  const ship = Number(data.shippingFee) || 0;
  const cod = Number(data.totalCOD) || 0;

  // totalCOD trong khối xác nhận là tổng cuối đã gồm phí ship:
  // chiết khấu = tổng hàng theo giá chốt + phí ship - COD.
  if (productsTotal > 0 && cod > 0) {
    const dc = productsTotal + ship - cod;
    return dc > 0 ? dc : 0;
  }

  // Dự phòng khi thiếu tổng hàng hoặc COD.
  const parsed = Number(data.discount) || 0;
  return parsed > 0 ? parsed : 0;
}

// Ô "Chiết khấu" - placeholder "Chiết khấu".
function findDiscountInput() {
  const el = document.querySelector("app-payment-crm-component input[placeholder='Chiết khấu']");
  if (el) return el;
  return findByPlaceholder("Chiết khấu");
}

// Đơn vị chiết khấu luôn dùng tiền mặt ($), không dùng phần trăm (%).
// Chỉ tác động dropdown có đúng hai option cash/percent trong khu vực thanh toán.
function ensureDiscountUnitCash() {
  const discountInput = findDiscountInput();
  const paymentComponent = discountInput?.closest("app-payment-crm-component")
    || document.querySelector("app-payment-crm-component");
  const candidates = Array.from(
    (paymentComponent || document).querySelectorAll("select")
  );
  const unitSelect = candidates.find((select) => {
    const values = Array.from(select.options || []).map((option) => option.value);
    return values.includes("cash") && values.includes("percent");
  });

  if (!unitSelect) {
    log("Không tìm thấy dropdown đơn vị chiết khấu ($/%).");
    return false;
  }

  if (unitSelect.value === "cash") {
    log("Đơn vị chiết khấu đã là $, giữ nguyên.");
    return true;
  }

  const cashOption = Array.from(unitSelect.options || []).find((option) => option.value === "cash");
  if (!cashOption) {
    log("Dropdown đơn vị chiết khấu không có option cash.");
    return false;
  }

  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(unitSelect, "cash");
  else unitSelect.value = "cash";
  unitSelect.dispatchEvent(new Event("input", { bubbles: true }));
  unitSelect.dispatchEvent(new Event("change", { bubbles: true }));
  log("Đã đổi đơn vị chiết khấu từ % sang $.");
  return unitSelect.value === "cash";
}

// Chọn mã khuyến mại HVC khớp với tên (hoặc một phần tên) cấu hình.
async function selectPromoCode(promoName) {
  const trigger = findPromoTrigger();
  if (!trigger) { log("selectPromoCode: không thấy ô 'Mã khuyến mại'."); return false; }
  log("selectPromoCode: click mở dropdown mã KM...");

  // Click mở dropdown (ô fakeInput readonly).
  simulateClick(trigger);
  await sleep(500);

  // Chờ dropdown + danh sách mã xuất hiện (gọi API, virtual scroll).
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (document.querySelector(".dropOptions.promotionalCode, .dropOptions")) break;
    await sleep(250);
  }
  await sleep(1200);

  // Gõ vào ô tìm trong dropdown để lọc còn ĐÚNG 1 mã (để select-all chọn đúng).
  const searchInput = document.querySelector(".dropOptions.promotionalCode input.handelQuery, .dropOptions input.handelQuery");
  if (searchInput) {
    // Thử lần lượt các khóa từ ĐẶC TRƯNG NHẤT -> chung, dừng khi còn 1 kết quả.
    const keys = buildPromoQueries(promoName);
    for (const key of keys) {
      log(`selectPromoCode: gõ lọc "${key}"`);
      searchInput.focus();
      setNativeValue(searchInput, "");
      await sleep(200);
      setNativeValue(searchInput, key);
      searchInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
      await sleep(1200);
      const n = getPromoItems().length;
      log(`-> còn ${n} mã sau lọc "${key}"`);
      if (n === 1) break;        // lọc chính xác về 1 mã -> dừng
      if (n >= 1 && key === keys[keys.length - 1]) break;
    }
  }

  let items = getPromoItems();
  log(`selectPromoCode: ${items.length} mã KM hiển thị`, items.slice(0, 8).map((i) => promoItemName(i)));
  if (!items.length) { log("selectPromoCode: chưa có mã KM nào."); return false; }

  // Sau khi gõ lọc, danh sách đã rút gọn -> ưu tiên khớp chính xác;
  // nếu không có khớp rõ thì CHỌN MỤC ĐẦU TIÊN (first) vì đã lọc đúng.
  const target = normalize(promoName);
  const tWords = target.split(" ").filter(Boolean);
  let best = null, bestScore = -1;
  for (const it of items) {
    const nameText = normalize(promoItemName(it));
    let score = 0;
    for (const w of tWords) if (w.length >= 2 && nameText.includes(w)) score++;
    if (nameText === target) score += 50;
    else if (nameText.includes(target)) score += 20;
    if (score > bestScore) { bestScore = score; best = it; }
  }

  // Nếu không khớp đủ mạnh -> lấy mục đầu tiên của danh sách đã lọc.
  if (!best || bestScore < 1) {
    best = items[0];
    log(`selectPromoCode: không khớp rõ -> chọn mục ĐẦU TIÊN "${promoItemName(best)}".`);
  } else {
    log(`selectPromoCode: khớp "${promoItemName(best)}" (score ${bestScore}).`);
  }

  // 'best' là .item. Trạng thái chọn = icon 'ph-check-square' / span.checked.
  if (isPromoChecked(best)) {
    log("selectPromoCode: mã đã được chọn sẵn.");
  } else {
    const itemEl = best.classList.contains("item") ? best : (best.closest(".item") || best);
    // Thử lần lượt NHIỀU cách, log trạng thái sau mỗi cách để biết cái nào ăn.
    const ticked = await tryTickPromo(itemEl);
    log(`selectPromoCode: tick sau khi thử các cách = ${ticked}`);
  }

  const ok = getPromoItems().length ? isPromoChecked(getPromoItems()[0]) : false;
  log(`selectPromoCode: trước khi đóng, tick = ${ok}`);

  // Đóng dropdown bằng CLICK THẬT ra vùng trống (để component ÁP DỤNG mã).
  // Click vào một điểm trống phía trên dropdown (ví dụ vùng tiêu đề "Vận chuyển").
  await realClickOutside();
  await sleep(700);

  log(`selectPromoCode: KẾT chọn = ${ok}`);
  return ok;
}

// Tick 1 mục mã KM bằng CLICK THẬT (chrome.debugger) vì synthetic click không ăn.
async function tryTickPromo(itemEl) {
  // Click thật vào .d-opt-left (vùng chứa icon + tên) - nơi người dùng bấm.
  const optLeft = itemEl.querySelector(".d-opt-left") || itemEl;
  log("tryTickPromo: dùng CLICK THẬT (debugger) vào .d-opt-left.");
  const clicked = await realClick(optLeft);
  await sleep(600);
  if (isPromoChecked(itemEl)) { log("tryTickPromo: ✅ đã tick (click thật)."); return true; }

  // Thử click thật vào icon nếu .d-opt-left chưa ăn.
  const icon = itemEl.querySelector("i.icon-check-d-select");
  if (icon) {
    log("tryTickPromo: thử CLICK THẬT vào icon.");
    await realClick(icon);
    await sleep(600);
    if (isPromoChecked(itemEl)) { log("tryTickPromo: ✅ đã tick (icon)."); return true; }
  }

  log(`tryTickPromo: ❌ vẫn chưa tick (clicked=${clicked}).`);
  return false;
}

// Đóng dropdown mã KM mà KHÔNG bấm nhầm vào mã (gây bỏ tick).
// Ưu tiên: nhấn Escape. Nếu chưa đóng -> click thật vào điểm XA dropdown.
async function realClickOutside() {
  // 1) Nhấn Escape trên ô tìm trong dropdown (đóng không cần click vào trang).
  const si = document.querySelector(".dropOptions.promotionalCode input.handelQuery, .dropOptions input.handelQuery");
  if (si) {
    log("realClickOutside: nhấn Escape để đóng dropdown.");
    si.focus();
    pressKey(si, "Escape", 27);
    si.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27 }));
    await sleep(500);
  }
  if (!document.querySelector(".dropOptions.promotionalCode, .dropOptions")) {
    log("realClickOutside: dropdown đã đóng bằng Escape.");
    return true;
  }

  // 2) Chưa đóng -> click thật vào điểm XA dropdown (tiêu đề "Khách hàng" ở trên cùng).
  const anchor = Array.from(document.querySelectorAll("app-customer-crm-component .tab-header h6, app-customer-crm-component .card-header, h6"))
    .find((el) => el.offsetParent !== null && /khách hàng/i.test(textOf(el)));
  if (anchor) {
    log(`realClickOutside: click thật vào "${textOf(anchor)}" (xa dropdown).`);
    await realClick(anchor);
    return true;
  }

  // 3) Dự phòng: click góc trên cùng bên trái iframe (chắc chắn xa dropdown mã KM).
  log("realClickOutside: click tọa độ góc trên.");
  await chrome.runtime.sendMessage({ type: "DEBUGGER_CLICK", x: 30, y: 30 });
  return true;
}

// Click THẬT qua chrome.debugger (isTrusted). Gửi tọa độ TRONG IFRAME;
// background cộng offset iframe (lấy từ frame top) vì iframe cross-origin.
async function realClick(el) {
  el.scrollIntoView({ block: "center", inline: "center" });
  await sleep(250);
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  log(`realClick: tọa độ trong-iframe (${Math.round(x)}, ${Math.round(y)})`);
  const res = await chrome.runtime.sendMessage({ type: "DEBUGGER_CLICK", x, y });
  return !!(res && res.ok);
}

// Click đầy đủ với tọa độ tâm phần tử (một số CDK component cần pointer thật).
function fullPointerClick(el) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
  try { el.dispatchEvent(new PointerEvent("pointerover", base)); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent("pointerenter", base)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mouseover", base));
  el.dispatchEvent(new MouseEvent("mousemove", base));
  try { el.dispatchEvent(new PointerEvent("pointerdown", base)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mousedown", base));
  try { el.dispatchEvent(new PointerEvent("pointerup", base)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
  if (typeof el.click === "function") el.click();
}

// Tên mã trong 1 item = <p class="fw-semibold"> (dòng đầu), KHÔNG lấy dòng mô tả.
function promoItemName(item) {
  const p = item.querySelector("p.fw-semibold, p.mb-0.fw-semibold");
  return p ? textOf(p) : textOf(item);
}

// Item đã được tick chưa? Dấu hiệu: .item có class .active, hoặc icon đổi
// từ 'ph-square' sang 'ph-check-square'/'ph-fill'.
// Trạng thái CHỌN THẬT:
//  - icon đổi 'ph-square' -> 'ph-check-square' (kèm 'ph-fill'), HOẶC
//  - <span class="checked"> xuất hiện.
// (class .active trên .item chỉ là highlight, KHÔNG phải chọn.)
function isPromoChecked(item) {
  if (!item) return false;
  const itemEl = item.classList.contains("item") ? item : (item.closest(".item") || item);
  const icon = itemEl.querySelector("i.icon-check-d-select");
  if (icon && /ph-check-square|ph-fill/.test(icon.className || "")) return true;
  if (itemEl.querySelector("span.checked")) return true;
  return false;
}

function findPromoItemByName(promoName) {
  const items = getPromoItems();
  const target = normalize(promoName);
  let best = null, bestScore = -1;
  for (const it of items) {
    const n = normalize(promoItemName(it));
    let score = 0;
    if (n === target) score = 100;
    else if (n.includes(target)) score = 50;
    else for (const w of target.split(" ")) if (w.length >= 2 && n.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 1 ? best : null;
}

// Tạo các khóa lọc mã KM từ đặc trưng nhất -> chung.
// VD "VOCMKT257_Oct_Multi 3PLsPromoted_10%" ->
//    ["3PLsPromoted_10%", "Multi 3PLsPromoted_10%", "Oct_Multi 3PLsPromoted_10%", full]
function buildPromoQueries(name) {
  const full = (name || "").trim();
  const noPrefix = full.replace(/^VOCMKT\d*_?/i, "").trim();        // "Oct_Multi 3PLsPromoted_10%"
  const afterOct = noPrefix.replace(/^Oct_?/i, "").trim();          // "Multi 3PLsPromoted_10%"
  // Lấy cụm cuối sau khoảng trắng (chứa phần % đặc trưng).
  const lastChunk = afterOct.split(/\s+/).slice(-1)[0] || afterOct; // "3PLsPromoted_10%"
  return [...new Set([lastChunk, afterOct, noPrefix, full])].filter((s) => s && s.length >= 2);
}

function findPromoTrigger() {
  // Tìm .fakeDSelect có label "Mã khuyến mại" -> lấy input.fakeInput bên trong.
  const labels = Array.from(document.querySelectorAll("label"));
  for (const lb of labels) {
    if (/^\s*mã khuyến mại\s*$/i.test(textOf(lb))) {
      const wrap = lb.closest(".fakeDSelect");
      if (wrap) {
        const input = wrap.querySelector("input.fakeInput") || wrap.querySelector("input");
        if (input) return input;
      }
    }
  }
  // Dự phòng: quét mọi fakeDSelect, chọn cái có label chứa "Mã khuyến mại".
  const fakes = Array.from(document.querySelectorAll(".fakeDSelect"));
  for (const f of fakes) {
    const lb = f.querySelector("label");
    if (lb && /mã khuyến mại/i.test(textOf(lb))) {
      const input = f.querySelector("input.fakeInput") || f.querySelector("input");
      if (input) return input;
    }
  }
  return null;
}

// Lấy các mục mã KM (.item) trong dropdown virtual-scroll.
function getPromoItems() {
  const box = document.querySelector(".dropOptions.promotionalCode, .dropOptions");
  if (!box) return [];
  const items = Array.from(box.querySelectorAll(".item"))
    .filter((el) => el.offsetParent !== null && promoItemName(el).length > 2);
  return items;
}

// Chọn trạng thái đơn hàng trong <select> (ví dụ "Đã xác nhận").
function setOrderStatus(statusText) {
  const selects = Array.from(document.querySelectorAll("select.form-select, select.form-control"));
  for (const sel of selects) {
    const opts = Array.from(sel.options || []);
    // Chỉ xét select có option "Trạng thái đơn hàng" hoặc chứa các trạng thái đã biết.
    const isStatusSelect = opts.some((o) => /trạng thái đơn hàng/i.test(o.textContent))
      || opts.some((o) => /đã xác nhận|chờ xác nhận/i.test(o.textContent));
    if (!isStatusSelect) continue;

    const match = opts.find((o) => normalize(o.textContent) === normalize(statusText))
      || opts.find((o) => normalize(o.textContent).includes(normalize(statusText)));
    if (match) {
      sel.value = match.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      log(`setOrderStatus: chọn "${textOf(match)}" (value=${match.value}).`);
      return true;
    }
  }
  log("setOrderStatus: không tìm thấy select trạng thái hoặc option khớp.");
  return false;
}

// Chờ hãng vận chuyển load xong (logo carrier xuất hiện) trước khi set phí ship.
async function waitForCarrier(timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const img = document.querySelector("img.image_carrier, app-img-custom .image_carrier");
    if (img && img.offsetParent !== null) return true;
    await sleep(300);
  }
  return !!document.querySelector("img.image_carrier");
}

// Ô "Phí ship báo khách" - placeholder rỗng, text nằm trong <label>.
function findShippingFeeInput() {
  const labels = Array.from(document.querySelectorAll(".form-floating label, label"));
  for (const lb of labels) {
    if (/phí ship/i.test(textOf(lb))) {
      const wrap = lb.closest(".form-floating") || lb.parentElement;
      const input = wrap?.querySelector("input");
      if (input) return input;
    }
  }
  return findByPlaceholder("Phí ship báo khách", "Phí ship");
}

// Ô địa chỉ chi tiết (số nhà/đường) nằm trong app-location-autocomplete, placeholder "Địa chỉ".
function findAddressDetailInput() {
  const el = document.querySelector("app-location-autocomplete input");
  if (el) return el;
  return findByPlaceholder("Địa chỉ");
}

// Ô địa chỉ hành chính (Tỉnh/Huyện/Xã) trong app-location-danymic: gõ rồi chọn gợi ý.
function findAddressRegionInput() {
  return document.querySelector("app-location-danymic input");
}

function getRegionSuggestionItems() {
  const wrap = document.querySelector("app-location-danymic .box_displaySearch, app-location-danymic .autoComplete_wrapper");
  if (!wrap) return [];
  // Gợi ý địa giới = .item-location (bỏ group_header chứa toggle).
  const items = Array.from(wrap.querySelectorAll(".item-location"))
    .filter((el) => el.offsetParent !== null && textOf(el).length > 2);
  return items;
}

// Kiểm tra Vpage đã chọn đủ cấp phường khi đang tìm theo địa chỉ 3 cấp chưa.
// Một số kết quả có vẻ được chọn thành công nhưng placeholder chỉ hiện "Quận X, Tỉnh Y".
function getRegionDisplayText(input) {
  if (!input) return "";
  const placeholder = (input.getAttribute("placeholder") || "").trim();
  // Vpage thường hiển thị địa giới đã chọn trong placeholder, còn value có thể rỗng.
  if (placeholder.includes(",")) return placeholder;
  return (input.value || placeholder).trim();
}

function isIncompleteThreeLevelSelection(input, regionText) {
  const parts = (regionText || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return false;

  const display = getRegionDisplayText(input);
  if (!display || !display.includes(",")) return false;

  const expectedWard = stripRegionType(parts[0]);
  const expectedProvince = parts[parts.length - 1];
  const displayParts = display.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const displayedProvince = displayParts[displayParts.length - 1] || "";

  // Chỉ xác định là "đã chọn thiếu phường" khi kết quả vẫn thuộc đúng tỉnh/thành đích.
  if (!sameProvinceName(displayedProvince, expectedProvince)) return false;

  const normalizedDisplay = normalize(display);
  const normalizedWard = normalize(expectedWard);
  const wardPresent = normalizedWard.length > 0 && normalizedDisplay.includes(normalizedWard);
  if (!wardPresent) {
    log(`fillAddressRegion: kết quả 3 cấp bị thiếu phường "${parts[0]}"; placeholder hiện "${display}".`);
    return true;
  }
  return false;
}

async function fillAddressRegion(region3, region2) {
  const input = findAddressRegionInput();
  if (!input) { log("fillAddressRegion: không thấy ô địa chỉ hành chính."); return false; }

  // Địa chỉ CÓ PHẢI 2 CẤP không? (chỉ 2 cụm: Phường + Tỉnh, KHÔNG có Quận/Huyện).
  const parts3 = (region3 || "").split(",").map((s) => s.trim()).filter(Boolean);
  // LƯU Ý: KHÔNG dùng \b quanh từ khoá tiếng Việt. Ký tự có dấu (ã, ị, ...)
  // không phải "word char" trong regex JS, nên \b sau "xã"/"ị" KHÔNG tạo ranh
  // giới -> /\bthị xã\b/ KHÔNG khớp "Thị xã Bến Cát" (bug cũ khiến bỏ qua cấp 3).
  // Dùng ranh giới tự chế: đầu chuỗi/khoảng trắng ... theo sau là khoảng trắng.

  // hasDistrictKeyword: có cụm Quận/Huyện/Thị xã/Thị trấn/Thành phố RÕ RÀNG.
  const hasDistrictKeyword = parts3.some((p) =>
    /(^|\s)(quận|huyện|thị xã|thị trấn|thành phố)(\s|$)/i.test(p));

  // Các tỉnh/thành dưới đây đã bị gom dữ liệu địa giới trên hệ thống.
  // Với địa chỉ thuộc các tỉnh này, mặc định ép cấp 3 và không fallback về cấp 2.
  const groupedProvinceNames = [
    "Hà Giang", "Yên Bái", "Bắc Kạn", "Hòa Bình", "Vĩnh Phúc",
    "Bắc Giang", "Thái Bình", "Hải Dương", "Hà Nam", "Nam Định",
    "Quảng Bình", "Quảng Nam", "Kon Tum", "Bình Định", "Phú Yên",
    "Ninh Thuận", "Đắk Nông", "Bình Thuận", "Bà Rịa – Vũng Tàu",
    "Bà Rịa - Vũng Tàu", "Bình Dương", "Bình Phước", "Long An",
    "Bến Tre", "Trà Vinh", "Sóc Trăng", "Hậu Giang", "Tiền Giang",
    "Kiên Giang", "Bạc Liêu"
  ];
  const normalizeProvince = (value) => String(value || "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/^(tinh|thanh pho|tp\.?)[ \t]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const groupedProvinceKeys = groupedProvinceNames.map(normalizeProvince);
  const hasGroupedProvince = parts3.some((part) => {
    const normalizedPart = normalizeProvince(part);
    return groupedProvinceKeys.some((province) =>
      normalizedPart === province || normalizedPart.endsWith(" " + province)
    );
  });

  // hasDistrict: địa chỉ có CẤP HUYỆN hay không? Dùng để quyết định toggle 2/3 cấp.
  // Đủ 3 cụm (Phường, Quận/TP, Tỉnh) HOẶC có từ khóa cấp huyện => 3 cấp.
  const hasDistrict = parts3.length >= 3 || hasDistrictKeyword;

  // hasNumberedWard: Phường dạng SỐ ("Phường 1", "Phường 09", ...).
  const hasNumberedWard = parts3.some((p) => {
    const noAccent = p.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return /\bphuong\s*\d+\b/.test(noAccent);
  });

  // forceLevel3: ép cấp 3 với phường dạng số, địa chỉ có cấp huyện rõ ràng,
  // hoặc tỉnh thuộc danh sách đã bị gom dữ liệu địa giới.
  // Với các tỉnh bị gom, tuyệt đối không fallback về cấp 2.
  const forceLevel3 = hasNumberedWard || hasDistrictKeyword || hasGroupedProvince;

  const isTwoLevel = forceLevel3 ? false : (parts3.length <= 2 || !hasDistrict);
  const r2 = region2 || region3;
  if (forceLevel3) {
    log(`fillAddressRegion: ÉP CẤP 3 (ward0x=${hasNumberedWard}, districtKw=${hasDistrictKeyword}) -> chỉ tìm 3 cấp.`);
  }

  // BƯỚC 1: CLICK THẬT vào ô địa chỉ để mở + focus.
  log(`fillAddressRegion: click thật vào ô địa chỉ (2cấp=${isTwoLevel}).`);
  await realClick(input);
  await sleep(600);

  // BƯỚC 2: ÉP toggle "Địa chỉ 2 cấp" về ĐÚNG chế độ của ĐƠN HIỆN TẠI.
  // nhanh.vn giữ trạng thái toggle từ đơn trước, nên phải đồng bộ lại:
  //  - đơn 2 cấp -> BẬT toggle
  //  - đơn 3 cấp -> TẮT toggle (nếu đơn trước để bật thì giờ phải tắt).
  const toggleChanged = !(() => {
    const t = findTwoLevelToggle();
    return t && t.cb && t.cb.checked === isTwoLevel; // đã đúng sẵn?
  })();
  await setTwoLevelAddress(isTwoLevel);
  if (toggleChanged) {
    await sleep(3000); // chờ tỉnh/thành load lại sau khi đổi chế độ
    await realClick(input);
    await sleep(500);
  }

  if (isTwoLevel) {
    // ƯU TIÊN addressRegion (đầy đủ/ngữ cảnh hơn) trước addressRegion2.
    // Chỉ fallback về addressRegion2 khi truy vấn addressRegion không tìm được
    // kết quả phù hợp; tránh chọn tỉnh/thành quá rộng chỉ vì có 1 gợi ý.
    log(`fillAddressRegion: ưu tiên addressRegion trước: "${region3}"`);
    if (await tryPickRegion(input, region3)) return true;
    log(`fillAddressRegion: addressRegion không khớp -> fallback addressRegion2 "${r2}"`);
    if (await tryPickRegion(input, r2)) return true;
    return false;
  }

  // Địa chỉ 3 cấp (toggle đã TẮT ở trên): thử 3 cấp trước.
  log(`fillAddressRegion: thử 3 cấp "${region3}"`);
  if (await tryPickRegion(input, region3)) return true;
  // Nếu đã chọn được kết quả nhưng placeholder chỉ có Quận/Tỉnh (thiếu phường),
  // cho phép fallback 2 cấp kể cả khi địa chỉ ban đầu được ép tìm 3 cấp.
  // Các trường hợp ép 3 cấp khác vẫn giữ nguyên hành vi cũ nếu không có dấu hiệu thiếu phường.
  const incompleteThreeLevelSelection = isIncompleteThreeLevelSelection(input, region3);
  if (forceLevel3 && !incompleteThreeLevelSelection) {
    log("fillAddressRegion: ÉP CẤP 3 -> không có dấu hiệu đã chọn thiếu phường; giữ nguyên chế độ 3 cấp.");
    return false;
  }

  // Không ra hoặc kết quả 3 cấp bị thiếu phường -> BẬT 'Địa chỉ 2 cấp' + thử lại.
  log(incompleteThreeLevelSelection
    ? "fillAddressRegion: kết quả 3 cấp thiếu phường -> BẬT 'Địa chỉ 2 cấp' để tìm lại."
    : "fillAddressRegion: 3 cấp không ra -> BẬT 'Địa chỉ 2 cấp' (dự phòng).");
  const toggled = await setTwoLevelAddress(true);
  if (toggled) {
    await sleep(3000); // chờ load lại sau khi đổi chế độ
    log("fillAddressRegion: click thật lại vào ô địa chỉ (sau khi bật 2 cấp).");
    await realClick(input);
    await sleep(500);
    log(`fillAddressRegion: thử 2 cấp "${r2}"`);
    if (await tryPickRegion(input, r2)) return true;
  }

  log("fillAddressRegion: không ra gợi ý nào (cả 3 cấp lẫn 2 cấp).");
  return false;
}

// Thử gõ các biến thể query và chọn gợi ý. Trả true nếu chọn được.
async function tryPickRegion(input, regionText) {
  const variants = buildRegionQueries(regionText);
  for (const q of variants) {
    log(`tryPickRegion: gõ "${q}"`);
    input.focus();
    input.dispatchEvent(new Event("focus", { bubbles: true }));
    setNativeValue(input, "");
    await sleep(300);
    setNativeValue(input, q);
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // Chờ 1 nhịp để API kịp nhận query (debounce của nhanh.vn ~300-500ms).
    await sleep(700);

    // CHỜ gợi ý xuất hiện VÀ ỔN ĐỊNH (nội dung không đổi trong vài lần đọc liên tiếp),
    // tránh race: API của query cũ chưa về đã đánh giá nhầm. Tăng timeout chờ lâu hơn.
    const items = await waitStableSuggestions(8000);
    log(`-> ${items.length} gợi ý địa giới (ổn định)`, items.slice(0, 5).map((i) => textOf(i)));
    if (!items.length) continue;

    const best = pickBestRegion(items, regionText);
    if (!best) {
      log("tryPickRegion: không có gợi ý khớp tỉnh -> thử query khác.");
      continue;
    }
    log(`tryPickRegion: chọn "${textOf(best)}" bằng CLICK THẬT.`);
    await realClick(best);
    await sleep(900);
    const picked = hasValue(input) || getRegionSuggestionItems().length === 0;
    log(`tryPickRegion: sau click, input="${input.value}", placeholder="${input.getAttribute("placeholder") || ""}", picked=${picked}`);
    if (picked) {
      if (isIncompleteThreeLevelSelection(input, regionText)) {
        log("tryPickRegion: đã chọn nhưng thiếu phường; thử biến thể query tiếp theo.");
        continue;
      }
      return true;
    }
    simulateClick(best);
    await sleep(600);
    if (hasValue(input) || getRegionSuggestionItems().length === 0) {
      if (isIncompleteThreeLevelSelection(input, regionText)) {
        log("tryPickRegion: sau click dự phòng vẫn thiếu phường; thử biến thể query tiếp theo.");
        continue;
      }
      return true;
    }
  }
  return false;
}

// Chờ danh sách gợi ý địa giới XUẤT HIỆN + ỔN ĐỊNH (không đổi giữa các lần đọc).
// Tránh chọn khi API của query cũ vừa trả / đang cập nhật dở.
// Tăng timeout mặc định + yêu cầu ổn định 3 nhịp để chờ gợi ý hiện chắc chắn.
async function waitStableSuggestions(timeout = 8000) {
  const start = Date.now();
  let prevKey = null;
  let stableCount = 0;
  let items = [];
  while (Date.now() - start < timeout) {
    items = getRegionSuggestionItems();
    const key = items.map((i) => textOf(i)).join("|");
    if (items.length && key === prevKey) {
      stableCount++;
      if (stableCount >= 3) return items; // ổn định 3 nhịp liên tiếp
    } else {
      stableCount = 0;
    }
    prevKey = key;
    await sleep(300);
  }
  return getRegionSuggestionItems();
}

// Tìm toggle "Địa chỉ 2 cấp": checkbox + label click được.
function findTwoLevelToggle() {
  // Ưu tiên trong khối địa chỉ (group_header có app-checkbox "Địa chỉ 2 cấp").
  const labels = Array.from(document.querySelectorAll("app-location-danymic label, label"));
  for (const lb of labels) {
    if (/địa chỉ 2 cấp/i.test(textOf(lb))) {
      const cb = lb.querySelector("input[type='checkbox']")
        || (lb.closest("app-checkbox") || lb.parentElement)?.querySelector("input[type='checkbox']");
      // Phần tử click được: cả label (để click thật trúng vùng toggle).
      return { cb, clickEl: lb };
    }
  }
  const cb = document.querySelector("app-location-danymic input[type='checkbox']");
  if (cb) {
    const lb = cb.closest("label") || cb.parentElement;
    return { cb, clickEl: lb || cb };
  }
  return null;
}

// Đặt toggle "Địa chỉ 2 cấp" về ĐÚNG trạng thái mong muốn bằng CLICK THẬT.
// desiredOn = true  -> BẬT (địa chỉ 2 cấp)
// desiredOn = false -> TẮT (địa chỉ 3 cấp)
// Quan trọng: nhanh.vn GIỮ trạng thái toggle giữa các đơn, nên phải ép đúng
// chế độ cho đơn hiện tại (bật nếu cần, TẮT nếu đang thừa). Trả true nếu
// sau cùng toggle khớp desiredOn.
async function setTwoLevelAddress(desiredOn) {
  const t = findTwoLevelToggle();
  if (!t || !t.cb) { log("setTwoLevelAddress: KHÔNG tìm thấy toggle."); return false; }

  if (t.cb.checked === desiredOn) {
    log(`setTwoLevelAddress: toggle đã đúng trạng thái (${desiredOn ? "BẬT" : "TẮT"}).`);
    return true;
  }

  // Click THẬT để đổi trạng thái; thử label rồi checkbox, tối đa 3 lần.
  const targets = [t.clickEl, t.cb, t.clickEl].filter(Boolean);
  for (let i = 0; i < targets.length; i++) {
    log(`setTwoLevelAddress: click THẬT lần ${i + 1} để ${desiredOn ? "BẬT" : "TẮT"}.`);
    await realClick(targets[i]);
    await sleep(700);
    const t2 = findTwoLevelToggle();
    if (t2 && t2.cb && t2.cb.checked === desiredOn) {
      log(`setTwoLevelAddress: ✅ đã ${desiredOn ? "BẬT" : "TẮT"}.`);
      return true;
    }
  }

  log(`setTwoLevelAddress: ❌ chưa đặt được về ${desiredOn ? "BẬT" : "TẮT"}.`);
  return false;
}

// Tương thích ngược: bật toggle (địa chỉ 2 cấp).
async function toggleTwoLevelAddress() {
  return setTwoLevelAddress(true);
}

// Tạo chuỗi tìm địa giới. ƯU TIÊN gõ KÈM LOẠI (Phường/Xã Tân Mỹ) trước,
// vì tên trùng ở nhiều tỉnh (HCM có Phường Tân Mỹ, Tuyên Quang có Xã Tân Mỹ).
function buildRegionQueries(regionText) {
  const stripType = (s) => (s || "")
    .replace(/^(phường|xã|thị trấn|thị xã|quận|huyện|thành phố|tỉnh|tp\.?)\s*/i, "")
    .trim();
  const expandAdminAbbreviation = (value) => {
    let part = (value || "").trim();
    // Chuẩn hóa bí danh TP.HCM trực tiếp về tên chuẩn mà Vpage sử dụng.
    if (/^tp\.?\s*(?:hcm|tphcm|hồ chí minh|ho chi minh|sài gòn|sai gon)$/i.test(part)) {
      return "Hồ Chí Minh";
    }
    // Mở rộng viết tắt địa giới chỉ trong các cụm địa chỉ hành chính.
    // Ví dụ: "p4" -> "Phường 4", "p Sài gòn" -> "Phường Sài gòn".
    // Chỉ mở rộng khi ký hiệu thực sự kết thúc ở dấu chấm, khoảng trắng
    // hoặc đứng trước số. Không được match đầu từ đầy đủ như "Phường", "Quận",
    // "Xã", "Huyện" (nếu không sẽ tạo "Phường hường", "Quận uận", ...).
    const rules = [
      [/^p(?:\.\s*|\s+|(?=\d))/i, "Phường "],
      [/^f(?:\.\s*|\s+|(?=\d))/i, "Phường "],
      [/^x(?:\.\s*|\s+|(?=\d))/i, "Xã "],
      [/^q(?:\.\s*|\s+|(?=\d))/i, "Quận "],
      [/^h(?:\.\s*|\s+|(?=\d))/i, "Huyện "],
      [/^tp(?:\.\s*|\s+|(?=\d))/i, "Thành phố "],
      [/^tx(?:\.\s*|\s+|(?=\d))/i, "Thị xã "],
      [/^tt(?:\.\s*|\s+|(?=\d))/i, "Thị trấn "]
    ];
    for (const [pattern, prefix] of rules) {
      if (pattern.test(part)) return part.replace(pattern, prefix).trim();
    }
    return part;
  };
  const parts = (regionText || "").split(",").map((s) => expandAdminAbbreviation(s)).filter(Boolean);
  // Địa chỉ cũ tại Quận 2 / Quận 9 (TP.HCM) nay tra cứu theo Thành phố Thủ Đức.
  // Chỉ đổi đúng cụm hành chính độc lập, không thay các phần tên đường/địa chỉ chi tiết.
  for (let i = 0; i < parts.length; i++) {
    if (/^quận\\s*[29]$/i.test(parts[i])) {
      parts[i] = "Thành phố Thủ Đức";
    }
  }
  // Nếu thiếu tỉnh/thành nhưng có đủ Phường + Quận/Huyện, thử thêm Hồ Chí Minh
  // vì nhiều địa chỉ khách ở TP.HCM thường được nhập thiếu cấp tỉnh/thành.
  const missingProvince = parts.length === 2
    && /^(quận|huyện|thị xã|thị trấn|thành phố)\s+/i.test(parts[1]);

  // Chỉ chuẩn hóa CẤP TỈNH/THÀNH PHỐ (cụm cuối cùng), không đụng
  // đến tiền tố Phường/Xã/Quận/Huyện ở các cấp địa giới bên dưới.
  // HCM/TP.HCM/TP HCM... -> "Hồ Chí Minh"; các tỉnh/thành khác cũng bỏ
  // tiền tố "Tỉnh", "Thành phố", "TP."... (vd "Tỉnh An Giang" -> "An Giang").
  if (parts.length) {
    const last = parts.length - 1;
    const provinceKey = canonicalProvince(parts[last]);
    if (provinceKey === "ho chi minh") {
      parts[last] = "Hồ Chí Minh";
    } else if (provinceKey === "ha noi") {
      parts[last] = "Hà Nội";
    } else if (provinceKey === "da nang") {
      parts[last] = "Đà Nẵng";
    } else {
      parts[last] = stripType(parts[last]);
    }
  }

  const queries = [];
  if (parts.length) {
    const first = parts[0]; // ví dụ "Phường Tân Mỹ" / "Phường 9"
    const district = parts.length >= 3 ? parts[1] : ""; // "Quận 8"
    const firstName = stripType(first);

    // 1) Phường + QUẬN để tránh nhầm phường trùng tên/số.
    if (district) queries.push(`${first} ${district}`);
    // 2) Giữ loại Phường/Xã trong từ khóa để lọc đúng loại.
    queries.push(first);
    // 3) Dự phòng bỏ tiền tố của phường/xã.
    if (firstName && firstName !== first) queries.push(firstName);

    // 4) Cụm dài nhưng tỉnh/thành đã được chuẩn hóa và bỏ tiền tố.
    queries.push(parts.join(", "));
    queries.push(parts.join(" "));
    // 5) Dự phòng cho địa chỉ thiếu tỉnh/thành (thường gặp ở TP.HCM).
    if (missingProvince) {
      queries.push(`${parts[0]} ${parts[1]} Hồ Chí Minh`);
      queries.push(`${parts[0]}, ${parts[1]}, Hồ Chí Minh`);
    }
  } else {
    queries.push(stripType(regionText));
  }
  return [...new Set(queries)].filter(Boolean);
}

// Chọn gợi ý địa giới khớp nhất. BẮT BUỘC khớp TỈNH (cụm cuối) để tránh nhầm
// phường trùng tên ở tỉnh khác. Trả null nếu không gợi ý nào đúng tỉnh.
// Bỏ tiền tố loại địa giới để so khớp tên thuần (Tỉnh/TP/Thành phố/Phường/Xã...).
function stripRegionType(s) {
  return normalize(s)
    .replace(/^(tinh|thanh pho|tp|phuong|xa|quan|huyen|thi tran|thi xa)\s+/i, "")
    .trim();
}

// Chuẩn hóa tên TỈNH về dạng chuẩn để xử lý viết tắt/bí danh:
//  "TP.HCM"/"HCM"/"Sài Gòn"/"TPHCM" -> "ho chi minh"
//  "HN"/"Hà Nội" -> "ha noi"; "Đà Nẵng"/"ĐN" -> "da nang"
// Nhờ đó "hcm" (đích) khớp được gợi ý "Hồ Chí Minh" của nhanh.vn.
function canonicalProvince(s) {
  let p = stripRegionType(s);                 // đã normalize + bỏ "tỉnh/tp..."
  p = p.replace(/\btp\b\.?\s*/g, "").trim();  // bỏ "tp" còn sót (vd "tp hcm")
  // Bí danh HCM.
  if (/\b(hcm|tphcm|sg|sai gon|ho chi minh)\b/.test(p) || p === "hcm") return "ho chi minh";
  // Bí danh Hà Nội.
  if (/\b(hn|ha noi)\b/.test(p) || p === "hn") return "ha noi";
  // Bí danh Đà Nẵng.
  if (/\b(dn|da nang)\b/.test(p)) return "da nang";
  return p;
}

// Hai tên tỉnh có cùng chỉ 1 tỉnh không? (so sau khi canonical + chứa lẫn nhau).
function sameProvinceName(a, b) {
  const ca = canonicalProvince(a);
  const cb = canonicalProvince(b);
  if (!ca || !cb) return false;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

// Chuẩn hóa QUẬN/HUYỆN để so khớp chính xác, kể cả dạng SỐ:
//  "Quận 8" -> "quan 8"; "Q8"/"q.8" -> "quan 8"; "Huyện Bình Chánh" -> "huyen binh chanh".
function normDistrict(s) {
  let x = normalize(s);
  // Gộp "q8"/"q 8"/"q.8" -> "quan 8"; tương tự huyện hiếm khi viết tắt số.
  x = x.replace(/\bq\.?\s*(\d+)\b/g, "quan $1");
  return x.trim();
}

// Lấy SỐ quận nếu có (vd "quan 8" -> "8"), để so khớp chặt quận dạng số.
function districtNumberOf(s) {
  const m = normDistrict(s).match(/\bquan\s*(\d+)\b/);
  return m ? m[1] : null;
}

function pickBestRegion(items, regionText) {
  // Chỉ chọn thẳng khi có đúng 1 gợi ý nếu gợi ý đó không quá rộng.
  // Ví dụ query "Long Biên, Hà Nội" nhưng kết quả duy nhất là "Hà Nội":
  // đây chỉ là tỉnh/thành, không xác nhận được phần "Long Biên", nên phải bỏ
  // qua và để caller thử query/fallback tiếp theo.
  if (Array.isArray(items) && items.length === 1) {
    const candidateText = textOf(items[0]).trim();
    const targetParts = (regionText || "").split(",").map((s) => s.trim()).filter(Boolean);
    const candidateParts = candidateText.split(/[，,\n]/).map((s) => s.trim()).filter(Boolean);
    const candidateIsOnlyTargetProvince =
      targetParts.length >= 2 &&
      candidateParts.length === 1 &&
      sameProvinceName(candidateParts[0], targetParts[targetParts.length - 1]);
    if (candidateIsOnlyTargetProvince) {
      log(`pickBestRegion: chỉ có 1 gợi ý "${candidateText}" nhưng không xác nhận được địa giới chi tiết của "${regionText}" -> không chọn, thử query/fallback khác.`);
      return null;
    }
    log(`pickBestRegion: chỉ có 1 gợi ý -> chọn trực tiếp "${candidateText}".`);
    return items[0];
  }

  const parts = regionText.split(",").map((s) => s.trim()).filter(Boolean);
  const missingProvince = parts.length === 2
    && /^(quận|huyện|thị xã|thị trấn|thành phố)\s+/i.test(parts[1]);
  const targetWard = parts.length ? normalize(parts[0]) : "";
  // Nếu chỉ có Phường + Quận/Huyện, coi Hồ Chí Minh là tỉnh/thành dự phòng
  // và vẫn lọc chính xác theo quận để tránh chọn nhầm phường cùng tên.
  const targetProvinceRaw = missingProvince ? "Hồ Chí Minh" : (parts.length ? parts[parts.length - 1] : "");
  const targetProvince = canonicalProvince(targetProvinceRaw);
  const targetDistrictRaw = missingProvince ? parts[1] : (parts.length >= 3 ? parts[1] : "");
  const targetDistrict = targetDistrictRaw ? normDistrict(targetDistrictRaw) : "";
  const targetDistrictNum = targetDistrictRaw ? districtNumberOf(targetDistrictRaw) : null;

  // Lấy TÊN TỈNH (cụm CUỐI) của một gợi ý, bỏ tiền tố loại. Gợi ý nhanh.vn
  // dạng "Phường X, Quận Y, Tỉnh Z" (hoặc 2 cấp "Phường X, Tỉnh Z") -> tỉnh là
  // cụm sau dấu phẩy cuối. So tỉnh với CỤM NÀY, KHÔNG so cả chuỗi để tránh
  // khớp nhầm khi tên tỉnh trùng tên phường (vd gợi ý "Phường Bình Dương,
  // Hồ Chí Minh" KHÔNG được coi là thuộc tỉnh "Bình Dương").
  const provinceOfItem = (it) => {
    // Tách theo dấu phẩy HOẶC xuống dòng (innerText đôi khi ngắt dòng thay phẩy).
    const segs = textOf(it).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : textOf(it);
  };

  // Lọc trước: chỉ giữ gợi ý có TỈNH khớp. So bằng canonicalProvince để
  // "TP.HCM"/"hcm" khớp được gợi ý "Hồ Chí Minh".
  let candidates = items;
  if (targetProvince && targetProvince.length >= 2) {
    const sameProvince = items.filter((it) => sameProvinceName(provinceOfItem(it), targetProvinceRaw));
    if (sameProvince.length) {
      candidates = sameProvince;
    } else {
      log(`pickBestRegion: KHÔNG có gợi ý nào khớp tỉnh "${targetProvince}" (raw="${targetProvinceRaw}") -> không chọn.`);
      return null;
    }
  }

  // Nếu có QUẬN/HUYỆN đích -> lọc tiếp theo quận để tránh nhầm phường trùng số
  // ở quận khác (vd "Phường 9" có ở Quận 3, Quận 8, Phú Nhuận...).
  if (targetDistrict) {
    const sameDistrict = candidates.filter((it) => {
      const itText = normDistrict(textOf(it));
      const itNum = districtNumberOf(textOf(it));
      if (targetDistrictNum) return itNum === targetDistrictNum; // quận số: khớp chính xác
      const dName = stripRegionType(targetDistrictRaw);          // quận/huyện tên
      return dName.length >= 2 && itText.includes(dName);
    });
    if (sameDistrict.length) {
      candidates = sameDistrict;
    } else {
      log(`pickBestRegion: KHÔNG có gợi ý khớp quận/huyện "${targetDistrictRaw}" -> không chọn.`);
      return null;
    }
  }

  // Trong các gợi ý cùng tỉnh + quận, chọn cái khớp phường nhất.
  const wardWords = targetWard.split(" ").filter(Boolean);
  const targetWardNum = districtNumberOf(parts[0] || "")
    || ((parts[0] || "").match(/\b(\d+)\b/) || [])[1] || null;
  let best = candidates[0], bestScore = -1;
  for (const it of candidates) {
    const itText = normalize(textOf(it));
    let score = 0;
    for (const w of wardWords) if (w.length >= 2 && itText.includes(w)) score++;
    if (targetWard && itText.includes(targetWard)) score += 20; // khớp cả "phường tân mỹ"
    // Phường dạng SỐ: cộng/trừ theo khớp số (tránh "Phường 9" vs "Phường 19").
    if (targetWardNum) {
      const itWardNum = (itText.match(/ph[uư][oơ]ng\s*(\d+)/) || [])[1] || null;
      if (itWardNum === targetWardNum) score += 10;
      else if (itWardNum && itWardNum !== targetWardNum) score -= 10;
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  log(`pickBestRegion: chọn "${textOf(best)}" (tỉnh="${targetProvince}", quận="${targetDistrictRaw}", score ${bestScore}).`);
  return best;
}

async function addProducts(products) {
  let count = 0;
  for (const p of products) {
    const input = findProductSearchInput();
    if (!input) {
      log("addProducts: KHÔNG tìm thấy ô '(F3) Tìm sản phẩm' -> dừng.");
      break;
    }

    const originalName = p.name || "";
    // Chuẩn hóa tên lấy từ tin nhắn khách về tên biến thể trong catalog.
    // Ví dụ "Gạo Thường (Không Cay)" -> "Gạo Thường - Không Cay".
    // Chỉ đổi cách viết biến thể đã biết, không tự bỏ thông tin vị sản phẩm.
    const fullName = normalizeIncomingProductName(originalName);
    const queries = buildProductQueries(fullName, p.search);
    log(`addProducts: gốc="${originalName}", chuẩn hóa="${fullName}" (từ khóa="${p.search || "-"}", SL ${p.quantity}), thử query:`, queries);

    let ok = false;
    for (const q of queries) {
      ok = await typeAndWait(input, q);
      log(`-> gõ "${q}", có gợi ý = ${ok}`);
      if (ok) break;
    }

    if (ok) {
      const items = getSuggestionItems();
      log(`-> ${items.length} gợi ý:`, items.map((i) => suggestionName(i)));

      const rowsBefore = countProductRows();
      const added1 = await chooseSuggestion(input, fullName, rowsBefore);
      log(`-> lần 1: chọn sản phẩm (bảng tăng dòng) = ${added1}`);

      if (added1) {
        count++;
        await sleep(500);

        const qty = Math.max(1, Number(p.quantity) || 1);
        if (qty > 1) {
          // Ưu tiên nhập trực tiếp số lượng vào ô SL như giá bán.
          // Chỉ chấp nhận nếu tổng SL của bảng (Angular model) phản ánh đúng thay đổi;
          // nếu component không cập nhật model thì trả ô về 1 rồi fallback cách thêm lại.
          const baselineTotalQty = totalQtyFromSummary();
          log(`-> thử nhập trực tiếp SL=${qty}; tổng SL trước=${baselineTotalQty}`);
          const directQtyOk = await setQuantityForProduct(fullName, qty);
          await sleep(700);
          const totalAfterDirect = totalQtyFromSummary();
          const directModelOk = directQtyOk
            && Number.isFinite(baselineTotalQty)
            && Number.isFinite(totalAfterDirect)
            && totalAfterDirect === baselineTotalQty + qty - 1;
          log(`-> nhập trực tiếp SL: inputOk=${directQtyOk}, tổng SL sau=${totalAfterDirect}, modelOk=${directModelOk}`);

          if (!directModelOk) {
            // Khôi phục số lượng 1 trước khi dùng fallback để tránh cộng trùng.
            await setQuantityForProduct(fullName, 1);
            await sleep(500);
            log(`-> ô SL không cập nhật model; fallback thêm lại sản phẩm để đạt SL=${qty}`);
            const okQty = await increaseQtyByReAdd(input, fullName, qty, p.search);
            log(`-> fallback tăng SL bằng cách thêm lại = ${okQty}`);
          }
        }

        // Chỉ ghi đè giá khi nội dung đơn có giá cụ thể khác giá catalog.
        // Thực hiện sau khi thêm/gộp đủ số lượng để tránh giá catalog ghi đè lại.
        const overridePrice = Number(p.overridePrice) || 0;
        if (overridePrice > 0) {
          await sleep(300);
          const okPrice = await setPriceForProduct(fullName, overridePrice);
          log(`-> cập nhật giá riêng ${overridePrice} cho "${fullName}" = ${okPrice}`);
        }
        await sleep(300);
      } else {
        log("-> KHÔNG thêm được sản phẩm vào bảng.");
      }
    } else {
      log("-> không có gợi ý để chọn.");
    }

    // Dọn ô tìm cho sản phẩm tiếp theo.
    try { setNativeValue(input, ""); } catch (_) {}
    await sleep(500);
  }
  return count;
}

// Tăng số lượng của 1 sản phẩm bằng cách THÊM LẠI nó cho đến khi đạt targetQty.
// Nhanh.vn tự gộp dòng trùng và tăng SL qua model (không cần set ô SL).
async function increaseQtyByReAdd(input, fullName, targetQty, search) {
  const queries = buildProductQueries(fullName, search);
  let guard = 0;

  for (let added = 1; added < targetQty && guard < targetQty + 3; guard++) {
    // Gõ lại tên để ra gợi ý.
    let ok = false;
    for (const q of queries) {
      ok = await typeAndWait(input, q);
      if (ok) break;
    }
    if (!ok) { log("increaseQtyByReAdd: không ra gợi ý, dừng."); break; }

    const before = currentQtyOf(fullName);
    // Chọn lại gợi ý (không cần bảng tăng dòng vì trùng -> chỉ tăng SL).
    const best = bestSuggestionEl(fullName);
    if (best) {
      const clickTargets = [best.querySelector("p.text-wrap"), best.querySelector(".flex-1"), best.querySelector(".d-flex"), best].filter(Boolean);
      for (const t of clickTargets) simulateClick(t);
    }
    // Chờ SL tăng.
    const okInc = await waitQtyIncrease(fullName, before, 2500);
    const now = currentQtyOf(fullName);
    log(`increaseQtyByReAdd: SL ${before} -> ${now} (tăng=${okInc})`);
    if (now > added) added = now; else if (okInc) added++;
    else { log("increaseQtyByReAdd: SL không tăng, dừng."); break; }

    try { setNativeValue(input, ""); } catch (_) {}
    await sleep(400);
  }
  return currentQtyOf(fullName) >= targetQty;
}

// Đọc SL hiện tại của dòng sản phẩm theo tên (từ ô input SL).
function currentQtyOf(fullName) {
  const row = findProductRow(fullName);
  if (!row) return 0;
  const qtyInput = getRowQtyInput(row);
  const v = qtyInput ? readNumber(qtyInput.value) : NaN;
  return isNaN(v) ? 0 : v;
}

// Đọc TỔNG SỐ LƯỢNG từ dòng tổng (tr.text-end cuối bảng) = phản ánh MODEL thật.
// Dòng tổng dạng: <td>150</td><td>1</td><td>79.000</td> -> ô giữa là tổng SL.
function totalQtyFromSummary() {
  const sumRow = document.querySelector("table tr.text-end:last-child, app-c-table tr.text-end");
  if (!sumRow) return NaN;
  const tds = Array.from(sumRow.children).filter((c) => c.tagName === "TD");
  // Ô SL tổng thường là td thứ 2 (index 1).
  if (tds[1]) return readNumber(textOf(tds[1]));
  return NaN;
}

async function waitQtyIncrease(fullName, baseline, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (currentQtyOf(fullName) > baseline) return true;
    await sleep(150);
  }
  return currentQtyOf(fullName) > baseline;
}

// Tìm dòng sản phẩm theo tên (khớp nhất).
function findProductRow(fullName) {
  const rows = Array.from(document.querySelectorAll("tr.productItem"));
  const target = normalize(fullName);
  let best = null, bestScore = -1;
  for (const r of rows) {    const rowName = normalize(textOf(r.querySelector(".productName")));
    let score = 0;
    if (rowName === target) score = 100;
    else if (rowName.includes(target) || target.includes(rowName)) score = 50;
    else for (const w of target.split(" ")) if (w.length >= 2 && rowName.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 2 ? best : null;
}

function countProductRows() {
  return document.querySelectorAll("tr.productItem").length;
}

// Chờ số dòng sản phẩm > baseline (tức là đã thêm được 1 dòng mới).
async function waitRowAdded(baseline, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (countProductRows() > baseline) return true;
    await sleep(150);
  }
  return countProductRows() > baseline;
}

// Thử nhiều cách chọn 1 gợi ý; trả true khi bảng tăng thêm dòng.
async function chooseSuggestion(input, targetName, rowsBefore) {
  // Cách 1: click phần tử con của gợi ý khớp nhất.
  const best = bestSuggestionEl(targetName);
  if (best && !suggestionMatchesVariant(targetName, suggestionName(best))) {
    log(`chooseSuggestion: từ chối gợi ý lệch vị "${suggestionName(best)}" cho "${targetName}"`);
    return false;
  }
  if (best) {
    log(`chooseSuggestion[click]: "${suggestionName(best)}"`);
    const clickTargets = [
      best.querySelector("p.text-wrap"),
      best.querySelector(".flex-1"),
      best.querySelector(".d-flex"),
      best.firstElementChild,
      best
    ].filter(Boolean);
    for (const t of clickTargets) simulateClick(t);
    if (await waitRowAdded(rowsBefore, 1800)) return true;
  }

  // Cách 2: dùng phím mũi tên xuống tới mục khớp rồi Enter.
  log("chooseSuggestion[keyboard]: ArrowDown + Enter");
  const idx = bestSuggestionIndex(targetName);
  for (let i = 0; i <= idx; i++) {
    pressKey(input, "ArrowDown", 40);
    await sleep(80);
  }
  pressEnter(input);
  if (await waitRowAdded(rowsBefore, 1800)) return true;

  // Cách 3: click thẳng mục KHỚP NHẤT nếu chỉ còn 1 gợi ý VÀ không lệch loại.
  const items = getSuggestionItems();
  if (items.length === 1) {
    if (suggestionMatchesType(targetName, suggestionName(items[0]))
        && suggestionMatchesVariant(targetName, suggestionName(items[0]))) {
      log("chooseSuggestion[single]: click mục duy nhất (cùng loại).");
      simulateClick(items[0]);
      if (await waitRowAdded(rowsBefore, 1800)) return true;
    } else {
      log(`chooseSuggestion[single]: BỎ QUA mục "${suggestionName(items[0])}" vì LỆCH LOẠI với "${targetName}".`);
    }
  }

  return false;
}

// So khớp biến thể vị cay. Đây là thuộc tính bắt buộc, không được coi
// "Không Cay", "Cay Vừa" và "Siêu Cay" là các tên gần tương đương.
function spiceVariant(name) {
  const n = normalize(name);
  if (/\bkhong cay\b/.test(n)) return "khong-cay";
  if (/\bsieu cay\b/.test(n)) return "sieu-cay";
  if (/\bcay vua\b/.test(n)) return "cay-vua";
  if (/\bit cay\b/.test(n)) return "it-cay";
  // Chỉ phân loại "cay" chung khi không có biến thể cụ thể ở trên.
  if (/\bcay\b/.test(n)) return "cay";
  return "";
}

function suggestionMatchesVariant(targetName, suggestionText) {
  const targetVariant = spiceVariant(targetName);
  if (!targetVariant) return true;
  return spiceVariant(suggestionText) === targetVariant;
}

// Kiểm tra mục gợi ý có CÙNG LOẠI (marker kích cỡ "đại"/"siêu đại") với tên
// đích không. Tránh thêm nhầm loại 500g khi khách đặt loại thường 250g.
function suggestionMatchesType(targetName, suggestionText) {
  const t = normalize(targetName);
  const s = normalize(suggestionText);
  for (const m of ["sieu dai", "dai"]) {
    const re = new RegExp(`\\b${m}\\b`);
    if (re.test(t) !== re.test(s)) return false;
  }
  return true;
}

function pressKey(el, key, keyCode) {
  const opts = { bubbles: true, cancelable: true, key, code: key, keyCode, which: keyCode };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

// Trả về phần tử gợi ý khớp nhất.
function bestSuggestionEl(targetName) {
  const items = getSuggestionItems();
  if (!items.length) return null;
  return items[bestSuggestionIndex(targetName)];
}

function bestSuggestionIndex(targetName) {
  const items = getSuggestionItems();
  const target = normalize(targetName);
  const targetWords = target.split(" ").filter(Boolean);

  // Trọng lượng trong tên mục tiêu (vd 500 trong "500gr") là ĐẶC TRƯNG quan
  // trọng -> khớp đúng số này được cộng điểm lớn, lệch bị trừ điểm.
  const targetWeight = (target.match(/\b(\d+)\s*(g|gr|gram|kg)\b/) || [])[1] || null;

  // Marker KÍCH CỠ/LOẠI của shop: "siêu đại"/"đại" = loại 500g; loại thường
  // (250g) KHÔNG có marker này. Phải phân biệt "Gạo Lứt" (250g) với
  // "ĐẠI - Gạo Lứt" (500g) dù trùng hết các từ còn lại.
  const SIZE_MARKERS = ["sieu dai", "dai"];
  const targetHasMarker = (m) => new RegExp(`\\b${m}\\b`).test(target);

  let bestIdx = 0, bestScore = -1;
  items.forEach((it, idx) => {
    const itText = normalize(suggestionName(it));
    let score = 0;
    for (const w of targetWords) if (w.length >= 2 && itText.includes(w)) score++;
    if (itText === target) score += 20;
    else if (itText.includes(target)) score += 10;

    // Ưu tiên khớp trọng lượng.
    if (targetWeight) {
      const itWeight = (itText.match(/\b(\d+)\s*(g|gr|gram|kg)\b/) || [])[1] || null;
      if (itWeight === targetWeight) score += 15;         // đúng trọng lượng
      else if (itWeight && itWeight !== targetWeight) score -= 15; // sai trọng lượng
    }

    // Phạt khi marker kích cỡ/loại LỆCH nhau (đích có mà mục không, hoặc ngược lại).
    for (const m of SIZE_MARKERS) {
      const tHas = targetHasMarker(m);
      const iHas = new RegExp(`\\b${m}\\b`).test(itText);
      if (tHas !== iHas) score -= 25; // lệch loại -> loại mạnh
    }

    if (score > bestScore) { bestScore = score; bestIdx = idx; }
  });
  return bestIdx;
}

function pressEnter(input) {
  const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
  input.dispatchEvent(new KeyboardEvent("keydown", opts));
  input.dispatchEvent(new KeyboardEvent("keypress", opts));
  input.dispatchEvent(new KeyboardEvent("keyup", opts));
}

// Chuẩn hóa tên sản phẩm từ nội dung đơn về cách đặt tên của catalog.
function normalizeIncomingProductName(name) {
  let n = String(name || "").trim();

  // Chuyển các biến thể viết trong ngoặc thành hậu tố tên catalog.
  // Giữ nguyên các từ phân biệt vị; không xóa "(Không Cay)" như quy cách đóng gói.
  n = n.replace(/\b(Gạo\s+Thường|Gạo\s+Lứt)\s*\(\s*(Không\s+Cay|Siêu\s+Cay|Cay\s+Vừa)\s*\)/gi,
    (_, base, variant) => `${base} - ${variant}`);

  // Loại bỏ cụm mô tả "Siêu Chà Bông" khi đi trước tên dòng đã xác định
  // trong catalog, ví dụ "Siêu Chà Bông - Gạo Thường (Không Cay)".
  n = n.replace(/\bSiêu\s+Chà\s+Bông\s*[-–:]\s*/i, "");

  // Tên catalog dùng "Cơm cháy ..." nhưng dữ liệu đơn có thể chỉ chứa phần lõi.
  return n.replace(/\s{2,}/g, " ").trim();
}

// Tạo các chuỗi tìm kiếm sản phẩm theo thứ tự ưu tiên:
// (1) tên ĐẦY ĐỦ giữ trọng lượng "500gr" (đặc trưng phân biệt) -> khớp đúng,
// (2) bỏ tiền tố "Cơm cháy" nhưng GIỮ trọng lượng,
// (3) DỰ PHÒNG rút gọn: bỏ trọng lượng/ngoặc khi các query trên không ra.
// searchKeyword (tùy chọn): TỪ KHÓA do CATALOG khai báo, tìm ra DUY NHẤT 1
// sản phẩm. Nếu có -> ƯU TIÊN TUYỆT ĐỐI, đặt đầu danh sách; các query tự suy
// ra chỉ còn là DỰ PHÒNG khi từ khóa không ra kết quả.
function buildProductQueries(name, searchKeyword) {
  const queries = [];
  const push = (q) => { if (q && !queries.includes(q)) queries.push(q); };

  const n = (name || "").trim();

  // CHỈ bỏ ngoặc dùng cho quy cách/khối lượng như "(250g)".
  // Không được xóa mọi nội dung trong ngoặc: "(Không Cay)" là thuộc tính
  // sản phẩm quan trọng, nếu bỏ sẽ dễ chọn nhầm "Siêu Cay".
  const noPackageParen = n
    .replace(/\(\s*\d+\s*(?:g|gr|gram|kg)\s*\)/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Ưu tiên tên đầy đủ có giữ biến thể/vị; từ khóa catalog chỉ là dự phòng
  // vì có thể là từ khóa chung không phân biệt vị.
  push(noPackageParen);
  push(noPackageParen.replace(/^c[ơo]m\s*ch[áa]y\s*/i, "").trim());

  // Biến thể bỏ dấu gạch nhưng vẫn giữ nguyên các từ phân biệt vị.
  const dashlessQueries = queries.map((q) =>
    q.replace(/[-–]/g, " ").replace(/\s{2,}/g, " ").trim()
  );
  dashlessQueries.forEach(push);

  // Dự phòng bỏ khối lượng rời; KHÔNG loại bỏ "Không Cay/Siêu Cay/Cay Vừa".
  const core = noPackageParen
    .replace(/\b\d+\s*(g|gr|gram|kg)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  push(core);
  push(core.replace(/^c[ơo]m\s*ch[áa]y\s*/i, "").trim());

  // Từ khóa catalog đặt sau các truy vấn giữ đủ tên và biến thể.
  if (searchKeyword && searchKeyword.trim()) push(searchKeyword.trim());

  return queries.filter((q) => q && q.length >= 2);
}

// Gõ một chuỗi vào ô tìm và chờ danh sách gợi ý xuất hiện.
async function typeAndWait(input, query) {
  input.focus();
  input.dispatchEvent(new Event("focus", { bubbles: true }));
  setNativeValue(input, "");
  await sleep(150);
  setNativeValue(input, query);
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  return waitForSuggestions(3000);
}

function findProductSearchInput() {
  // 1) Theo component suggestion.
  let el = document.querySelector(
    "app-c-product-suggestion input[type='text'], app-c-suggestion-product input[type='text']"
  );
  if (el) { log("findProductSearchInput: tìm thấy qua app-c-product-suggestion."); return el; }

  // 2) Theo <label> chứa 'Tìm sản phẩm' (placeholder rỗng nên không dùng placeholder được).
  const labels = Array.from(document.querySelectorAll(".form-floating label, label"));
  for (const lb of labels) {
    if (/tìm sản phẩm/i.test(textOf(lb))) {
      const wrap = lb.closest(".form-floating") || lb.parentElement;
      const input = wrap?.querySelector("input[type='text'], input:not([type])");
      if (input) { log("findProductSearchInput: tìm thấy qua <label> 'Tìm sản phẩm'."); return input; }
    }
  }

  // 3) Dự phòng theo placeholder (nếu có).
  const byPh = findByPlaceholder("Tìm sản phẩm", "(F3) Tìm sản phẩm");
  log("findProductSearchInput: fallback placeholder =", byPh ? "OK" : "KHÔNG THẤY");
  return byPh;
}

// Các selector có thể chứa danh sách gợi ý sản phẩm.
const SUGGESTION_ITEM_SELECTORS = [
  "app-c-product-suggestion .search-result li",
  "app-c-suggestion-product .search-result li",
  ".search-result-suggestion-product li",
  ".autoComplete_wrapper .search-result li",
  ".search-result li",
  ".node-item"
];

// Text của các item RÁC (không phải sản phẩm) mà nhanh.vn hiển thị khi không
// có kết quả / đang tải. Phải loại ra, nếu không sẽ bị tưởng là "có gợi ý".
function isNoResultItem(el) {
  const t = normalize(textOf(el));
  return !t
    || /khong tim thay|khong co (san pham|ket qua|du lieu)|dang tai|loading|no result|empty/.test(t);
}

function getSuggestionItems() {
  for (const sel of SUGGESTION_ITEM_SELECTORS) {
    const items = Array.from(document.querySelectorAll(sel))
      .filter((el) => el.offsetParent !== null && textOf(el)) // chỉ phần tử đang hiển thị
      .filter((el) => !isNoResultItem(el));                   // bỏ "Không tìm thấy sản phẩm"
    if (items.length) return items;
  }
  return [];
}

async function waitForSuggestions(timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getSuggestionItems().length) return true;
    await sleep(200);
  }
  return getSuggestionItems().length > 0;
}

// Chuẩn hóa text để so khớp (bỏ dấu, thường hóa).
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/đ/g, "d")                 // 'đ' là ký tự riêng, NFD không tách -> xử lý trước
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Lấy riêng TÊN sản phẩm trong 1 item gợi ý (bỏ phần giá).
function suggestionName(item) {
  // Tên nằm ở <p class="... text-wrap"> (dòng tên), giá ở <p> text-end.
  const nameEl = item.querySelector("p.text-wrap")
    || item.querySelector(".flex-1 p")
    || item.querySelector("p");
  return textOf(nameEl) || textOf(item);
}

// Phát đầy đủ chuỗi sự kiện chuột lên 1 phần tử để Angular/ngb nhận click.
function simulateClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  if (typeof el.click === "function") el.click();
}

// Lấy ô SỐ LƯỢNG của một dòng sản phẩm.
// Cấu trúc: td[0]=tên+ảnh, td[1]=SỐ LƯỢNG, td[2]=giá, td[3]=actions.
function getRowQtyInput(row) {
  const tds = Array.from(row.children).filter((c) => c.tagName === "TD");

  // Ưu tiên: input autonumeric trong td thứ 2 (index 1).
  if (tds[1]) {
    const el = tds[1].querySelector("input[autonumeric], input[appautonumericwrapper], input.text-end");
    if (el) return el;
  }

  // Fallback: ô có width ~3rem.
  const inputs = Array.from(row.querySelectorAll("input[autonumeric], input[appautonumericwrapper]"));
  const byWidth = inputs.find((el) => /width:\s*3rem/i.test(el.getAttribute("style") || ""));
  if (byWidth) return byWidth;

  // Fallback cuối: input đầu tiên của dòng.
  return inputs[0] || null;
}

// Set giá bán cho đúng dòng sản phẩm. Chỉ gọi khi giá trích từ đơn khác catalog.
async function setPriceForProduct(productName, price) {
  const row = findProductRow(productName);
  if (!row) {
    log(`setPriceForProduct: không tìm thấy dòng "${productName}".`);
    return false;
  }

  const tds = Array.from(row.children).filter((el) => el.tagName === "TD");
  const priceInput = tds[2]?.querySelector("input[autonumeric], input[appautonumericwrapper], input.text-end");
  if (!priceInput) {
    log(`setPriceForProduct: không tìm thấy ô Giá trong dòng "${productName}".`);
    return false;
  }

  const currentPrice = readNumber(priceInput.value);
  if (currentPrice === Number(price)) {
    log(`setPriceForProduct: giá đã đúng ${price}.`);
    return true;
  }

  log(`setPriceForProduct: "${productName}" giá hiện tại=${priceInput.value}, giá cần đặt=${price}`);
  const ok = await setNumericByPaste(priceInput, price);
  await sleep(300);
  const verified = readNumber(priceInput.value) === Number(price);
  log(`setPriceForProduct: kết quả set=${ok}, xác minh=${verified}, giá cuối="${priceInput.value}"`);
  return ok && verified;
}

// Set số lượng cho đúng dòng chứa sản phẩm có tên khớp; nếu không tìm thấy thì dùng dòng cuối.
async function setQuantityForProduct(productName, qty) {
  const rows = Array.from(document.querySelectorAll("tr.productItem"));
  log(`setQuantityForProduct('${productName}', ${qty}): có ${rows.length} dòng sản phẩm.`);
  if (!rows.length) return false;

  const target = normalize(productName);
  let row = null;

  // Tìm dòng có tên khớp nhất.
  let bestScore = -1;
  for (const r of rows) {
    const nameEl = r.querySelector(".productName");
    const rowName = normalize(textOf(nameEl));
    let score = 0;
    if (rowName === target) score = 100;
    else if (rowName.includes(target) || target.includes(rowName)) score = 50;
    else {
      for (const w of target.split(" ")) if (w.length >= 2 && rowName.includes(w)) score++;
    }
    if (score > bestScore) { bestScore = score; row = r; }
  }

  if (!row) row = rows[rows.length - 1];
  const qtyInput = getRowQtyInput(row);
  if (!qtyInput) { log("setQuantityForProduct: không thấy ô SL trong dòng."); return false; }

  const rowName = textOf(row.querySelector(".productName"));
  log(`-> set SL=${qty} cho dòng "${rowName}". Giá trị hiện tại="${qtyInput.value}"`);
  return await setNumericByPaste(qtyInput, qty);
}

// Set giá trị cho ô numeric (chiết khấu/phí ship/số lượng) bằng PASTE,
// thử vài biến thể input và chọn cái cho ra đúng giá trị sau format.
async function setNumericByPaste(el, target) {
  const candidates = [
    String(target),                                        // "18000"
    String(target).replace(/\B(?=(\d{3})+(?!\d))/g, "."),  // "18.000"
    String(target * 10),                                   // "180000"
    String(target * 10).replace(/\B(?=(\d{3})+(?!\d))/g, ".") // "180.000"
  ];

  for (const cand of candidates) {
    log(`setNumericByPaste: thử PASTE "${cand}" (mong muốn ${target})`);
    await pasteIntoNumeric(el, cand);
    await sleep(400);

    // Mô phỏng hover để xem component format/commit ra gì.
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await sleep(600);
    log(`-> sau paste+hover: value="${el.value}"`);

    if (readNumber(el.value) === Number(target)) {
      log(`setNumericByPaste: OK với input "${cand}".`);
      return true;
    }
  }
  log("setNumericByPaste: không biến thể nào ra đúng -> giữ nguyên.");
  return false;
}

// Dán 1 chuỗi vào ô numeric: focus + SELECT (bôi đen bằng el.select()) rồi paste đè.
async function pasteIntoNumeric(el, str) {
  log(`pasteIntoNumeric: focus ô (value hiện tại="${el.value}")`);
  el.focus();
  el.dispatchEvent(new Event("focus", { bubbles: true }));
  await sleep(200);

  // Bôi đen TOÀN BỘ bằng select() (chỉ ăn khi ô có sẵn giá trị).
  try { el.select(); } catch (_) {}
  try { el.setSelectionRange(0, (el.value || "").length); } catch (_) {}
  const selLen = (el.selectionEnd || 0) - (el.selectionStart || 0);
  log(`pasteIntoNumeric: đã select, selectionLength=${selLen}`);
  await sleep(150);

  // CHỈ phát paste event 1 lần (component có _onPasteFunc tự chèn).
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", str);
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    el.dispatchEvent(ev);
  } catch (_) {}

  await sleep(300);

  // Fallback insertText nếu paste chưa ăn.
  if (readNumber(el.value) !== Number(str.replace(/[^\d]/g, ""))) {
    log(`pasteIntoNumeric: paste event chưa ăn (value="${el.value}") -> fallback insertText.`);
    try { el.select(); } catch (_) {}
    document.execCommand("insertText", false, str);
    await sleep(200);
  }

  // Kích hoạt event để Angular ngModel/formControl nhận giá trị (commit MODEL),
  // nhưng KHÔNG blur/mouseleave (những cái này làm xóa trắng ô).
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: str, inputType: "insertFromPaste" }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  // keyup giả để một số component cập nhật qua (keyup).
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0", keyCode: 48 }));

  await sleep(400);
  log(`pasteIntoNumeric: KẾT value="${el.value}"`);
}

// Đọc số từ chuỗi autonumeric ("2", "2.000", "1,000"...).
function readNumber(s) {
  const d = String(s || "").replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : NaN;
}

/* ============== LẮNG NGHE MESSAGE ============== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "COLLECT_MESSAGES") {
    sendResponse(collectMessages(msg.msgCount || 3));
    return false;
  }
  if (msg?.type === "COLLECT_SHOP_ORDER") {
    // Trả về khối đơn hàng nếu 1 trong N tin GẦN NHẤT (mặc định 3) do SHOP gửi
    // đúng định dạng đơn. Chỉ đọc N tin cuối, từ dưới lên.
    const all = readAllMessages();
    const lastN = msg.lastN || 3;
    sendResponse({ orderText: findShopOrderMessage(all, lastN) });
    return false;
  }
  if (msg?.type === "COLLECT_RECENT_MESSAGES") {
    const all = readAllMessages();
    const lastN = Math.max(1, Math.min(Number(msg.lastN) || 3, 10));
    sendResponse({
      messages: all.slice(-lastN).map((m) => ({
        role: m.role,
        sender: m.sender || "",
        text: m.text || ""
      }))
    });
    return false;
  }
  if (msg?.type === "GET_IFRAME_OFFSET") {
    // Chạy ở frame top: tìm iframe tạo đơn (crmadd) và trả vị trí của nó.
    const ifr = document.querySelector("iframe#addOrder, iframe[src*='crmadd']");
    if (ifr) {
      const r = ifr.getBoundingClientRect();
      sendResponse({ x: r.left, y: r.top });
    } else {
      sendResponse({ x: 0, y: 0 });
    }
    return false;
  }
  if (msg?.type === "OPEN_ORDER_TAB") {
    // Tab "Đơn hàng" (mat-tab-label) nằm ở trang chat để mở panel iframe tạo đơn.
    // Cho phép click ở frame nào có đúng tab mat-tab-label này.
    const clicked = clickOrderTabStrict();
    sendResponse({ clicked });
    return false;
  }
  if (msg?.type === "FILL_FORM") {
    const data = { ...(msg.data || {}), mode: msg.mode || msg.data?.mode || "manual" };
    fillForm(data)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ filled: false, info: "Lỗi điền: " + e.message }));
    return true;
  }
});

} // end guard chống nạp trùng (window.__dsFillContentLoaded)