// Service worker: điều phối luồng Tự điền.
// 1) Thu thập tin nhắn + khối xác nhận đơn từ các frame.
// 2) Nếu có khối xác nhận đơn -> parse trực tiếp (chính xác, không tốn API).
//    Ngược lại -> gọi DeepSeek phân tích hội thoại.
// 3) Gửi dữ liệu tới frame chứa form để điền.

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// Chặn lên đơn nếu một trong 3 tin nhắn gần nhất có nội dung "Theo dõi vận chuyển".
function normalizeTrackingText(value = "") {
  return String(value).toLowerCase().replace(/đ/g, "d")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim();
}
function hasRecentTrackingInbox(messages) {
  return (Array.isArray(messages) ? messages : []).slice(-3)
    .some((message) => normalizeTrackingText(typeof message === "string" ? message : (message?.text || "")).includes("theo doi van chuyen"));
}

// Dừng hoàn toàn thông báo Telegram và tự lên đơn nếu 3 tin cuối đã là tin hậu xử lý/CSKH.
// Danh sách tin được trả theo thứ tự cũ -> mới, nên slice(-3) là 3 tin mới nhất từ dưới lên.
function hasRecentStopPhrase(messages, count = 3) {
  const limit = Math.min(Math.max(parseInt(count, 10) || 3, 1), 10);
  const recent = (Array.isArray(messages) ? messages : []).slice(-limit);
  const stopPhrases = ["theo doi van chuyen", "thong bao tu bep", "tran trong"];
  // Một tin xác nhận đơn mới hơn phải thắng dấu tracking cũ hơn trong cùng cửa sổ.
  // Ví dụ: tin cũ có link tracking, sau đó shop nhắn "lên đơn thành công" cho đơn mới.
  const orderSuccessPhrases = [
    "len don thanh cong",
    "da len don",
    "em len don cho minh",
    "em gui don cho minh",
    "tao don thanh cong",
    "don hang da duoc tao"
  ];
  let lastStopIndex = -1;
  let lastSuccessIndex = -1;
  recent.forEach((message, index) => {
    const text = normalizeTrackingText(typeof message === "string" ? message : (message?.text || ""));
    if (stopPhrases.some((phrase) => text.includes(phrase))) lastStopIndex = index;
    if (orderSuccessPhrases.some((phrase) => text.includes(phrase))) lastSuccessIndex = index;
  });
  // Chỉ chặn nếu dấu hiệu tracking/CSKH là sự kiện mới nhất so với xác nhận đơn.
  return lastStopIndex >= 0 && lastStopIndex >= lastSuccessIndex;
}
/* ============== PARSE KHỐI XÁC NHẬN ĐƠN ============== */
// Dạng mẫu (từ "Tin nhắn CSKH tự động"):
//   Mã đơn hàng: 869721432
//   Tên người nhận: Huỳnh Hiền
//   Số điện thoại: 0908018663
//   Địa chỉ: ... Phường Tân Sơn Nhì, , Hồ Chí Minh
//   Sản Phẩm: 1 x Cơm cháy Gạo Thường - Cay Vừa - 79,000
//             2 x Cơm cháy Gạo Thường - Siêu Cay - 79,000
//   Phí vận chuyển: 0
//   Chiết khấu: 18,000
//   Tổng: 219,000

function toNumber(s) {
  if (!s) return 0;
  const digits = String(s).replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

// Chuẩn hóa đơn vị tiền tệ trên object trích xuất.
// DeepSeek đôi khi trả "219K" -> 219 (thiếu số 0). Giá sản phẩm sau khi map
// CATALOG là VND đầy đủ (vd 79000), nên nếu một trường tiền NHỎ BẤT THƯỜNG so
// với thang nghìn thì nhân 1000 để khôi phục.
// Quy tắc: coi là tiền thật khi >= 1000; nếu 0 < giá trị < 1000 thì nhân 1000.
function normalizeMoneyFields(obj) {
  if (!obj) return obj;

  const fix = (v) => {
    const n = Number(v) || 0;
    // 0 giữ nguyên (nghĩa là không có / freeship). Chỉ sửa số lẻ < 1000.
    if (n > 0 && n < 1000) return n * 1000;
    return n;
  };

  // Giá từng sản phẩm.
  if (Array.isArray(obj.products)) {
    for (const p of obj.products) {
      if (p && p.price != null) p.price = fix(p.price);
    }
  }
  // Các trường tiền cấp đơn.
  if (obj.shippingFee != null) obj.shippingFee = fix(obj.shippingFee);
  if (obj.totalCOD != null) obj.totalCOD = fix(obj.totalCOD);
  if (obj.discount != null) obj.discount = fix(obj.discount);

  return obj;
}

// Bỏ cấp Quận 2 / Quận 9 cũ khỏi phần hành chính TP.HCM.
// Chỉ xử lý addressRegion (không đụng phần số nhà/đường) và chỉ khi địa chỉ
// có dấu hiệu thuộc TP.HCM/TP Thủ Đức để tránh xóa nhầm địa danh ở nơi khác.
function removeObsoleteHcmDistricts(region) {
  if (!region) return "";
  const isHcm = /hồ\\s*chí\\s*minh|ho\\s*chi\\s*minh|\\bhcm\\b|sài\\s*gòn|sai\\s*gon|thủ\\s*đức|thu\\s*duc/i.test(region);
  if (!isHcm) return region;

  const parts = region.split(",").map((part) => part.trim()).filter(Boolean);
  const obsoleteDistrict = /^(?:quận\\s*[29]|q\\.?\\s*[29])$/i;
  const cleaned = parts
    .filter((part) => !obsoleteDistrict.test(part))
    // "TP Thủ Đức" là cấp trung gian không cần gửi nguyên cụm khi tìm địa giới.
    // Giữ tên "Thủ Đức" để có thể dùng làm cấp giữa nếu hệ thống cần.
    .map((part) => /^(?:tp\\.?\\s*)?thủ\\s*đức$/i.test(part) ? "Thủ Đức" : part);

  return cleaned.join(", ").replace(/\\s{2,}/g, " ").trim();
}
function cleanAddress(addr) {
  return addr
    .replace(/\s*,\s*,\s*/g, ", ") // bỏ dấu phẩy rỗng ", ,"
    .replace(/\s{2,}/g, " ")
    .replace(/^,|,$/g, "")
    .trim();
}

// Tách "địa chỉ đầy đủ" thành phần chi tiết (đường/nhà) và phần hành chính.
// Ví dụ: "Dc 304/10/12a tân kỳ..., Phường Tân Sơn Nhì, Hồ Chí Minh"
//   -> address = "Dc 304/10/12a tân kỳ..."
//      addressRegion = "Phường Tân Sơn Nhì, Hồ Chí Minh"
function splitAddress(full) {
  if (!full) return { address: "", addressRegion: "" };

  // Chuẩn hóa phường/quận viết tắt có dấu phẩy:
  // "... P.5, Q.3" hoặc "... P5, Q3" -> "... Phường 5, Quận 3".
  // Chỉ khớp cụm P + số, Q + số ở cuối địa chỉ hoặc trước dấu phẩy tiếp theo.
  full = full.replace(
    /\bp\.?\s*(\d+)\s*,\s*q\.?\s*(\d+)(?=\s*(?:,|$))/i,
    "Phường $1, Quận $2"
  );

  // Tách cụm phường + quận viết liền ở cuối địa chỉ:
  // "231/83/12L đường Bá Trạc p1q8" -> "... đường Bá Trạc, Phường 1, Quận 8"
  // Hỗ trợ số bất kỳ (p1q10, p12q5), có/không có dấu chấm hoặc khoảng trắng.
  // Chỉ khớp khi cụm hành chính nằm cuối chuỗi hoặc ngay trước dấu phẩy.
  full = full.replace(
    /\s+p\.?\s*(\d+)\s*q\.?\s*(\d+)(?=\s*(?:,|$))/i,
    ", Phường $1, Quận $2"
  );

  const parts = full.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return { address: full, addressRegion: "" };

  // Tách phường/xã bị viết liền với số nhà/đường, ví dụ:
  // "94/7a Quang Trung xã Hóc Môn, Tp. HCM".
  const inlineWard = parts[0].match(/^(.*?)(?:\s+)((?:phường|xã|thị trấn)\s+.+)$/i);
  if (inlineWard && inlineWard[1].trim() && inlineWard[2].trim()) {
    parts[0] = inlineWard[2].trim();
    parts.unshift(inlineWard[1].trim());
  }

  // Phần hành chính CHUẨN nằm ở CUỐI, mỗi cụm bắt đầu bằng từ loại địa giới.
  const startsWithType = (p) =>
    /^(phường|xã|quận|huyện|thị trấn|thị xã|thành phố|tỉnh|tp\.?|p(?=\.)|q(?=\.)|tt\.?)(?=\s|$|[.,])/i.test(p); // KHÔNG dùng \b: "phố"/"xã" kết thúc bằng ký tự có dấu, \b không tạo ranh giới

  // Quét từ cuối lên: gom các cụm liên tiếp thuộc hành chính.
  // Cụm cuối cùng (tên tỉnh) có thể không có từ loại -> luôn tính là hành chính.
  let idx = parts.length; // vị trí bắt đầu phần hành chính
  for (let i = parts.length - 1; i >= 1; i--) {
    const isLast = i === parts.length - 1;
    if (startsWithType(parts[i]) || isLast) {
      idx = i;
    } else {
      break;
    }
  }

  // Nếu không tách được (idx vẫn ở cuối), lấy tối đa 3 cụm cuối làm hành chính.
  if (idx === parts.length) idx = Math.max(1, parts.length - 3);

  const address = parts.slice(0, idx).join(", ").trim();
  const addressRegion = parts.slice(idx).join(", ").trim();
  return { address: address || full, addressRegion };
}

// Parse khối sản phẩm, hỗ trợ:
//  "+ 2 x Cơm cháy Gạo Thường - Siêu Cay (250g)"   (format mới, không giá)
//  "1 x Cơm cháy Gạo Thường - Cay Vừa - 79,000"     (format cũ, có giá cuối)
function parseProductLines(block) {
  const products = [];
  if (!block) return products;

  // Tách thành từng "đơn vị" bắt đầu bằng [+ optional] SL x ...
  // Dùng lookahead tới điểm bắt đầu dòng sản phẩm kế tiếp (hoặc hết chuỗi).
  const unitRe = /\+?\s*(\d+)\s*x\s*([\s\S]*?)(?=(?:\+?\s*\d+\s*x\s)|$)/gi;
  let m;
  while ((m = unitRe.exec(block)) !== null) {
    const qty = parseInt(m[1], 10);
    let rest = (m[2] || "").trim();
    if (!rest) continue;

    // Phòng trường hợp nội dung dán là một dòng dài: cắt phần sản phẩm ngay khi
    // gặp nhãn trường đơn tiếp theo, để giá "(60,000)" không bị xem là nằm giữa
    rest = rest.replace(/\s+(?=(?:Phí vận chuyển|Chiết khấu|Tổng(?: thanh toán)?|Ghi chú|Vận chuyển|Hình thức vận chuyển|Người nhận|Tên người nhận|Số điện thoại|Địa chỉ)\s*:)[\s\S]*$/i, "").trim();
    if (!rest) continue;

    // Nếu có " - <số tiền>" (format cũ) thì tách ra làm giá. Cho phép giá đứng
    // ở CUỐI phần tên HOẶC ngay trước dấu phân cách sản phẩm kế (; ,) để xử lý
    // nhiều sản phẩm có giá nằm trên cùng một dòng.
    let price = 0;
    // Ưu tiên bắt giá ghi trong ngoặc ở bất kỳ vị trí nào của phần sản phẩm,
    // phòng trường hợp văn bản dán có ký tự/dấu câu dư ở cuối.
    const priceM = rest.match(/\(\s*(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*\)/)
      || rest.match(/\s[-–]\s*(\d{1,3}(?:[.,]\d{3})+|\d{4,})(?=\s|[;,]|$)/);
    if (priceM) {
      price = toNumber(priceM[1]);
      rest = rest.slice(0, priceM.index).trim();
    }

    // Bỏ dấu phẩy/chấm/chấm phẩy cuối dòng thừa.
    const name = rest.replace(/[.,;]\s*$/, "").trim();
    if (name) products.push({ quantity: qty || 1, name, price });
  }
  return products;
}

// Tách sản phẩm TRỰC TIẾP từ hội thoại bằng JS Regex (không qua AI).
// Mục đích: giữ NGUYÊN VĂN dòng gạo/vị cay khách-shop chốt, tránh DeepSeek tự
// "suy diễn" đổi "Thường" <-> "Lứt". Trả [{quantity,name,price}] hoặc [].
//
// messages: mảng chuỗi dạng "(SHOP) tên: nội dung" / "(KHÁCH) tên: nội dung".
// Chiến lược: duyệt từ tin MỚI NHẤT -> cũ, lấy tin ĐẦU TIÊN parse ra >=1 sản
// phẩm. Ưu tiên tin có nhiều dòng "N x ..." (danh sách chốt đơn).
function extractProductsFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];

  // Mẫu 1 dòng sản phẩm: [+] <số> [x|X|*] <tên...>. Bắt buộc có "x/X/*" giữa
  // số và tên để tránh nhầm số điện thoại/tiền.
  const lineHasProduct = /\+?\s*\d+\s*[x*]\s*\S/i;

  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i] || "";
    // Bỏ tiền tố "(SHOP) tên:" / "(KHÁCH) tên:" nếu có, lấy phần nội dung.
    const body = raw.replace(/^\s*\((?:SHOP|KHÁCH)\)[^:]*:\s*/i, "");
    if (!lineHasProduct.test(body)) continue;

    // Chuẩn hóa "*" -> "x" để parseProductLines (vốn bắt "N x ...") dùng được.
    const normalized = body.replace(/(\d+)\s*\*\s*/g, "$1 x ");
    const products = parseProductLines(normalized);
    if (products.length) return products;
  }
  return [];
}

// Địa chỉ có CẦN DeepSeek chuẩn hóa không?
// Không cần nếu addressRegion đã rõ (chứa Phường/Xã + có ít nhất 2 cụm phân tách).
function addressNeedsAI(extracted) {
  const region = extracted.addressRegion || "";
  const parts = region.split(",").map((s) => s.trim()).filter(Boolean);
  const hasWard = /(phường|xã|thị trấn)(?=\s|,|$)/i.test(region);
  const hasProvinceLike = parts.length >= 2; // có ít nhất Phường + Tỉnh
  // Dấu hiệu "thập cẩm" ở phần detail: viết tắt c/c, nhiều từ không dấu chuẩn...
  const detail = extracted.address || "";
  const messy = /\bp\b|\bq\d|\bc\/c\b|\btp\b/i.test(detail) && !hasWard;
  // Cần AI nếu: thiếu phường rõ, hoặc region quá ngắn, hoặc detail lộn xộn.
  if (!hasWard || !hasProvinceLike) return true;
  if (messy) return true;
  return false;
}

// Tạo địa chỉ 2 cấp từ 3 cấp bằng JS: bỏ cụm Quận/Huyện ở giữa, giữ Phường + Tỉnh.
function buildTwoLevelRegion(region3) {
  if (!region3) return "";
  const parts = region3.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 2) return region3;
  // parts = [Phường, Quận/Huyện, ..., Tỉnh] -> giữ đầu (phường) + cuối (tỉnh).
  return [parts[0], parts[parts.length - 1]].join(", ");
}

// Chuẩn hóa bỏ dấu để so khớp tên tỉnh linh hoạt.
function normVN(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Địa chỉ có thuộc "nhóm HCM" (HCM hoặc tỉnh lân cận cấu hình) không?
function isHcmLikeRegion(regionText, hcmProvinces) {
  const r = normVN(regionText);
  // Luôn tính HCM.
  if (/ho chi minh|tp hcm|\bhcm\b|sai gon/.test(r)) return true;
  // Các tỉnh lân cận do người dùng cấu hình (ngăn cách dấu phẩy).
  const list = (hcmProvinces || "").split(",").map((x) => normVN(x)).filter(Boolean);
  for (const prov of list) {
    if (prov && r.includes(prov)) return true;
  }
  return false;
}

function parseOrderConfirmation(text) {
  if (!text) return null;

  // Chuẩn hóa: bỏ gạch đầu dòng "- ", chèn xuống dòng trước các nhãn đã biết.
  // Hỗ trợ cả 2 format: "[XÁC NHẬN ĐƠN HÀNG]" và "Em gửi đơn...".
  let t = text
    .replace(/\s*[-–]\s*(Số điện thoại)/gi, "\nSố điện thoại")
    .replace(/\s*[-–]\s*(Địa chỉ)/gi, "\nĐịa chỉ")
    .replace(/\s*[-–]\s*(Sản ?phẩm)/gi, "\nSản phẩm")
    .replace(/\s*[-–]\s*(Tổng thanh toán)/gi, "\nTổng thanh toán")
    .replace(/\s*[-–]\s*(Hình thức thanh toán)/gi, "\nHình thức thanh toán")
    .replace(/Mã đơn hàng\s*:/i, "\nMã đơn hàng:")
    .replace(/Tên người nhận\s*:/i, "\nTên người nhận:")
    .replace(/Số điện thoại\s*:/i, "\nSố điện thoại:")
    .replace(/Địa chỉ\s*:/i, "\nĐịa chỉ:")
    .replace(/Sản ?[Pp]hẩm\s*:/i, "\nSản phẩm:")
    .replace(/Phí vận chuyển\s*:/i, "\nPhí vận chuyển:")
    .replace(/Chiết khấu\s*:/i, "\nChiết khấu:")
    .replace(/Tổng thanh toán\s*\(COD\)\s*:/i, "\nTổng:")
    .replace(/Tổng thanh toán\s*:/i, "\nTổng:")
    .replace(/Tổng\s*:/i, "\nTổng:")
    .replace(/Hình thức thanh toán\s*:/i, "\nHình thức thanh toán:")
    .replace(/Theo dõi vận chuyển\s*:/i, "\nTheo dõi vận chuyển:")
    .replace(/Ghi chú\s*:/i, "\nGhi chú:")
    .replace(/(?<!Tên )Người nhận\s*:/i, "\nTên người nhận:")
    .replace(/(?<!Phí )Vận chuyển\s*:/i, "\nVận chuyển:");

  const grab = (label, stopLabels) => {
    const stop = stopLabels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(label + "\\s*([\\s\\S]*?)(?=\n(?:" + stop + ")|$)", "i");
    const m = t.match(re);
    return m ? m[1].trim() : "";
  };

  const STOPS = ["Mã đơn hàng:", "Tên người nhận:", "Số điện thoại:", "Địa chỉ:",
    "Sản phẩm:", "Phí vận chuyển:", "Chiết khấu:", "Tổng:",
    "Hình thức thanh toán:", "Vận chuyển:", "Theo dõi vận chuyển:", "Ghi chú:"];

  const name = grab("Tên người nhận:", STOPS);
  const phoneRaw = grab("Số điện thoại:", STOPS);
  const phone = (phoneRaw.match(/\d[\d\s.]{7,}/) || [""])[0].replace(/[^\d]/g, "");
  let fullAddress = cleanAddress(grab("Địa chỉ:", STOPS));
  // Bỏ SĐT bị lặp (có thể ở đầu hoặc giữa).
  if (phone) {
    fullAddress = fullAddress.replace(new RegExp(phone, "g"), " ");
  }
  fullAddress = cleanAddress(fullAddress);

  // Tách địa chỉ chi tiết (đường/nhà) và phần hành chính (Phường/Xã, Quận/Huyện, Tỉnh).
  const { address, addressRegion: rawAddressRegion } = splitAddress(fullAddress);
  const addressRegion = removeObsoleteHcmDistricts(rawAddressRegion);
  if (addressRegion !== rawAddressRegion) {
    blog(`Đã tiền xử lý địa chỉ hành chính cũ: "${rawAddressRegion}" -> "${addressRegion}"`);
  }

  const productsBlock = grab("Sản phẩm:", STOPS);
  blog("DIAG parseOrderConfirmation: productsBlock =", JSON.stringify(productsBlock));
  const products = parseProductLines(productsBlock);
  blog("DIAG parseOrderConfirmation: products =", JSON.stringify(products));

  // Các tin nhắn chat tiếp theo có thể nằm ngay sau "Tổng: 279,000"
  // và chứa SĐT. Không được gom tất cả chữ số trong cả đoạn (sẽ thành
  // 2790000939790038). Chỉ parse token tiền đầu tiên sau mỗi nhãn.
  const grabMoney = (label) => {
    const raw = grab(label, STOPS);
    const firstAmount = raw.match(/\d[\d.,]*/);
    return firstAmount ? toNumber(firstAmount[0]) : 0;
  };
  const shippingFee = grabMoney("Phí vận chuyển:");
  const discount = grabMoney("Chiết khấu:");
  const totalCOD = grabMoney("Tổng:");
  const rawNote = grab("Ghi chú:", STOPS);
  // "Không" nghĩa là khách không để lại ghi chú; không điền chữ này vào textarea.
  const note = /^không\s*[.!]?$/i.test(rawNote.trim()) ? "" : rawNote.trim();

  // Nếu không bắt được gì cốt lõi thì coi như thất bại.
  if (!phone && !products.length) return null;

  return {
    name,
    phone,
    address,
    addressRegion,
    products,
    shippingFee,
    discount,
    totalCOD,
    note,
    _source: "confirmation"
  };
}

/* ============== DEEPSEEK ============== */

function buildPrompt(messages, catalog) {
  const catalogText = catalog
    ? `\n\nDANH MỤC SẢN PHẨM CHUẨN (CATALOG) - ánh xạ tên khách/shop nói về đúng tên trong danh mục nếu khớp:\n${catalog}`
    : "";

  return `Bạn trích xuất thông tin ĐƠN HÀNG ĐÃ CHỐT từ hội thoại chat bán hàng tiếng Việt (Facebook/Zalo).
Mỗi dòng có nhãn (SHOP) hoặc (KHÁCH). Thông tin SĐT và địa chỉ thường do KHÁCH cung cấp;
sản phẩm/giá/tổng tiền thường do SHOP chốt. Lấy thông tin ở các tin GẦN NHẤT (cuối danh sách).

Trả về DUY NHẤT JSON hợp lệ (không markdown):
{
  "name": "tên khách",
  "phone": "chuỗi số điện thoại",
  "address": "địa chỉ chi tiết: số nhà, đường, tổ/ấp (KHÔNG gồm phường/xã/quận/huyện/tỉnh)",
  "addressRegion": "phần hành chính: Phường/Xã, Quận/Huyện, Tỉnh/Thành phố (địa chỉ mới sau sáp nhập nếu có)",
  "products": [ { "quantity": số, "name": "tên sản phẩm chuẩn", "price": số } ],
  "shippingFee": số,
  "totalCOD": số (tổng cuối gồm phí ship),
  "note": ""
}

Quy tắc số: '219K' hoặc '219k' = 219000; bỏ dấu phẩy/chấm phân cách; 'freeship'/'FREESHIP' => shippingFee = 0.
Nếu không chắc, để '' hoặc 0. products = [] nếu không rõ.${catalogText}

HỘI THOẠI (cũ -> mới):
${messages.join("\n")}`;
}

async function callDeepSeek({ apiToken, model, messages, catalog }) {
  const body = {
    model: model || "deepseek-chat",
    messages: [
      { role: "system", content: "Bạn chỉ trả lời bằng JSON hợp lệ." },
      { role: "user", content: buildPrompt(messages, catalog) }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  };

  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiToken },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const tx = await resp.text().catch(() => "");
    throw new Error(`DeepSeek API ${resp.status}: ${tx.slice(0, 200)}`);
  }
  const data = await resp.json();
  saveUsage(data?.usage, model);
  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(content);
  parsed._source = "deepseek";
  return parsed;
}

// Dùng DeepSeek chuẩn hóa địa chỉ "thập cẩm" -> cấu trúc rõ ràng.
// Trả về { detail, ward, district, province } để extension ghép linh hoạt
// (thử 3 cấp trước, 2 cấp sau).
async function normalizeAddressWithAI({ apiToken, model, rawAddress }) {
  const prompt = `Bạn chuẩn hóa địa chỉ giao hàng tiếng Việt (có thể viết tắt, lộn xộn, thiếu dấu).

Địa chỉ gốc: "${rawAddress}"

Trả về DUY NHẤT JSON:
{
  "detail": "số nhà, đường, tòa nhà/chung cư/ngõ/hẻm (KHÔNG gồm phường/quận/tỉnh)",
  "ward": "Phường/Xã (ghi đầy đủ: 'Phường An Đông', 'Xã ...', giữ đúng tên; KHÔNG gồm quận/tỉnh)",
  "district": "Quận/Huyện/Thành phố trực thuộc (VD 'Quận 5', 'Huyện Bình Chánh'); để '' nếu không xác định",
  "province": "Tỉnh/Thành phố trực thuộc TW (VD 'Hồ Chí Minh', 'Bình Dương')"
}

Quy tắc:
- Viết tắt thường gặp: 'p'/'P.' = Phường, 'q'/'Q.' = Quận, 'tp' = Thành phố, 'c/c' = chung cư, 'đ'/'đường' = đường.
- Chuẩn hóa hoa thường đúng tên riêng.
- Chỉ dùng thông tin có trong địa chỉ gốc, KHÔNG bịa phường/quận không có.
- Nếu không rõ quận, để district = ''.`;

  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiToken },
    body: JSON.stringify({
      model: model || "deepseek-chat",
      messages: [
        { role: "system", content: "Bạn chỉ trả lời bằng JSON hợp lệ." },
        { role: "user", content: prompt }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    })
  });
  if (!resp.ok) {
    const tx = await resp.text().catch(() => "");
    throw new Error(`DeepSeek address ${resp.status}: ${tx.slice(0, 150)}`);
  }
  const data = await resp.json();
  saveUsage(data?.usage, model);
  const content = data?.choices?.[0]?.message?.content || "";
  return parseJsonLoose(content);
}

// Lưu thông tin usage của lần gọi gần nhất + cộng dồn tổng.
function saveUsage(usage, model) {
  if (!usage) return;
  chrome.storage.local.get({ usageTotal: { prompt: 0, completion: 0, total: 0, calls: 0 } }, (st) => {
    const t = st.usageTotal;
    const last = {
      model: model || "",
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      at: new Date().toISOString()
    };
    const usageTotal = {
      prompt: t.prompt + last.prompt_tokens,
      completion: t.completion + last.completion_tokens,
      total: t.total + last.total_tokens,
      calls: t.calls + 1
    };
    chrome.storage.local.set({ lastUsage: last, usageTotal });
  });
}

// Kiểm tra token + lấy số dư tài khoản DeepSeek.
async function checkAccount(apiToken) {
  if (!apiToken) return { ok: false, error: "Chưa nhập API Token." };
  try {
    const resp = await fetch("https://api.deepseek.com/user/balance", {
      method: "GET",
      headers: { Authorization: "Bearer " + apiToken, Accept: "application/json" }
    });
    if (resp.status === 401) return { ok: false, live: false, error: "Token không hợp lệ (401)." };
    if (!resp.ok) {
      const tx = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${tx.slice(0, 120)}` };
    }
    const data = await resp.json();
    return {
      ok: true,
      live: true,
      isAvailable: !!data.is_available,
      balances: Array.isArray(data.balance_infos) ? data.balance_infos : []
    };
  } catch (e) {
    return { ok: false, error: "Lỗi mạng: " + e.message };
  }
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); }
  catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    throw new Error("Không parse được JSON từ AI: " + text.slice(0, 150));
  }
}

// CATALOG mặc định (dùng khi config trống) - đồng bộ với options.js.
// CATALOG mặc định. Mỗi dòng: "Tên hiển thị :: từ khóa tìm : giá".
// - "Tên hiển thị": tên đầy đủ để map từ hội thoại/khối xác nhận.
// - ":: từ khóa tìm" (TÙY CHỌN): TỪ KHÓA gõ vào ô tìm sản phẩm trên nhanh.vn,
//   là chuỗi tìm ra DUY NHẤT 1 sản phẩm (do shop cung cấp). Nếu có, tool CHỈ
//   gõ đúng từ khóa này, KHÔNG tự suy ra biến thể.
const DEFAULT_CATALOG = `Cơm cháy Gạo Thường - Cay Vừa :: Gạo Thường - Cay Vừa: 79000
Cơm cháy Gạo Thường - Siêu Cay :: Gạo Thường - Siêu Cay: 79000
Cơm cháy Gạo Thường - Không Cay :: Gạo Thường - Không Cay: 79000
Thường Siêu Đại 500gr - Cay Vừa :: Thường Siêu Đại 500gr - Cay Vừa: 158000
Thường Siêu Đại 500gr - Siêu Cay :: Thường Siêu Đại 500gr - Siêu Cay: 158000
Thường Siêu Đại 500gr - Không Cay :: Thường Siêu Đại 500gr - Không Cay: 158000
Cơm cháy Gạo Lứt - Cay Vừa :: Cơm cháy Gạo Lứt - Cay Vừa: 85000
Cơm cháy Gạo Lứt - Siêu Cay :: Cơm cháy Gạo Lứt - Siêu Cay: 85000
Cơm cháy Gạo Lứt - Không Cay :: Cơm cháy Gạo Lứt - Không Cay: 85000
Cơm cháy Đại - Gạo Lứt - Cay vừa :: Đại - Gạo Lứt - Cay vừa: 170000
Cơm cháy Đại - Gạo Lứt - Siêu Cay :: Đại - Gạo Lứt - Siêu Cay: 170000
Cơm cháy Đại - Gạo Lứt - Không cay :: Đại - Gạo Lứt - Không cay: 170000
Cơm cháy Gạo Thường Rong Biển Mix :: Gạo Thường Rong Biển Mix: 85000
Cơm cháy Gạo Lứt Rong Biển Mix :: Gạo Lứt Rong Biển Mix: 90000
Cơm Cháy Rong Biển chay :: Rong Biển chay: 80000
Cơm cháy chay đặc biệt :: chay đặc biệt: 90000
Cơm cháy tép hành phi :: tép hành phi: 75000
Chà Bông :: Chà Bông: 100000
Rong Biển Siêu Mè Chay :: Siêu Mè Chay: 69000
Sườn non sấy chay - 165gr :: Sườn non sấy chay: 79000`;

// Parse CATALOG text (mỗi dòng "Tên: giá") -> [{name, price}].
// Parse CATALOG text. Mỗi dòng: "Tên hiển thị [:: từ khóa tìm] : giá".
// Trả [{ name, search, price }]. 'search' = từ khóa tìm ra DUY NHẤT sản phẩm
// (nếu dòng không khai báo thì search = name).
function parseCatalog(catalog) {
  if (!catalog) return [];
  return catalog.split(/\r?\n/).map((line) => {
    let t = line.trim().replace(/^\d+[.)]\s*/, ""); // bỏ số thứ tự đầu dòng nếu có
    if (!t) return null;

    // Tách GIÁ ở cuối (sau dấu ':' hoặc '-' cuối cùng đứng trước số tiền).
    let price = 0;
    const priceM = t.match(/[:\-]\s*([\d.,]+)\s*(?:vnd|đ)?\s*$/i);
    if (priceM && /\d/.test(priceM[1])) {
      price = toNumber(priceM[1]);
      t = t.slice(0, priceM.index).trim();
    }

    // Tách TỪ KHÓA tìm (sau '::'); phần trước là tên hiển thị.
    let name = t, search = "";
    const sepIdx = t.indexOf("::");
    if (sepIdx >= 0) {
      name = t.slice(0, sepIdx).trim();
      search = t.slice(sepIdx + 2).trim();
    }
    name = name.replace(/[:\-]\s*$/, "").trim();
    if (!name) return null;
    if (!search) search = name; // không khai báo -> dùng chính tên

    return { name, search, price };
  }).filter((x) => x && x.name);
}

// Chuẩn hóa để so khớp: bỏ dấu, thường hóa, bỏ ký tự đặc biệt & trọng lượng.
// Bỏ hậu tố trọng lượng trong ngoặc ở CUỐI tên, vd "... (250g)" / "...(250 g)"
// / "... (1kg)" -> bỏ. Chỉ cắt ngoặc chứa trọng lượng, KHÔNG đụng ngoặc khác.
function stripWeightSuffix(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/\s*\(\s*\d+\s*(?:g|gr|gram|kg)\s*\)\s*$/i, "")
    .trim();
}

function normName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    // Chỉ bỏ ngoặc quy cách/khối lượng; giữ "(Cay Vừa)", "(Siêu Cay)", "(Không Cay)"
    // để mapProductsToCatalog nhận diện đúng biến thể, tránh chọn nhầm vị.
    .replace(/\(\s*\d+\s*(?:g|gr|gram|kg)\s*\)/g, " ")
    .replace(/\b\d+\s*(g|gr|gram|kg)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Trích các THUỘC TÍNH PHÂN BIỆT từ tên đã chuẩn hóa (normName -> bỏ dấu).
// Đây là các đặc trưng QUAN TRỌNG để không map nhầm biến thể gần giống nhau.
function productAttrs(norm) {
  return {
    // Vị cay: phải phân biệt "khong cay" / "sieu cay" / "cay vua".
    spice: /khong cay/.test(norm) ? "khong"
      : /sieu cay/.test(norm) ? "sieu"
        : /cay vua|cay v/.test(norm) ? "vua"
          : null,
    // Dòng gạo: lứt vs thường.
    grain: /gao lut|lut/.test(norm) ? "lut"
      : /gao thuong|thuong/.test(norm) ? "thuong"
        : null,
    // Cỡ lớn 500g: "siêu đại" (Thường Siêu Đại) hoặc "đại" (Đại - Gạo Lứt).
    big: /sieu dai/.test(norm) ? "sieudai"
      : /\bdai\b/.test(norm) ? "dai"
        : null,
    // Rong biển / mix.
    rongbien: /rong bien/.test(norm),
    mix: /\bmix\b/.test(norm)
  };
}

// Ép mỗi sản phẩm về đúng tên NGUYÊN VĂN trong CATALOG bằng fuzzy match
// CÓ TRỌNG SỐ cho các thuộc tính phân biệt (vị cay, dòng gạo, cỡ, rong biển).
function mapProductsToCatalog(products, catalogList, preserveExtractedPrices = false) {
  if (!Array.isArray(products) || !catalogList.length) return products;

  const catNorm = catalogList.map((c) => {
    const norm = normName(c.name);
    return { ...c, norm, words: norm.split(" ").filter(Boolean), attrs: productAttrs(norm) };
  });

  return products.map((p) => {
    const target = normName(p.name);
    const tWords = target.split(" ").filter(Boolean);
    const tAttr = productAttrs(target);

    let best = null, bestScore = -1;
    for (const c of catNorm) {
      let score = 0;
      // Đếm từ chung 2 chiều.
      for (const w of tWords) if (w.length >= 2 && c.norm.includes(w)) score++;
      for (const w of c.words) if (w.length >= 2 && target.includes(w)) score += 0.5;
      if (c.norm === target) score += 100;

      // --- Trọng số thuộc tính phân biệt ---
      // Vị cay: khớp +8, lệch (cả hai đều xác định mà khác nhau) -20.
      if (tAttr.spice && c.attrs.spice) {
        score += tAttr.spice === c.attrs.spice ? 8 : -20;
      }
      // Dòng gạo (lứt/thường): khớp +6, lệch -15.
      if (tAttr.grain && c.attrs.grain) {
        score += tAttr.grain === c.attrs.grain ? 6 : -15;
      }
      // Cỡ lớn (đại/siêu đại) vs loại thường: lệch -15.
      if (tAttr.big !== c.attrs.big) {
        score -= 15;
      }
      // Rong biển / mix: lệch -10 mỗi đặc trưng.
      if (tAttr.rongbien !== c.attrs.rongbien) score -= 10;
      if (tAttr.mix !== c.attrs.mix) score -= 10;

      c._score = score;
      if (score > bestScore) { bestScore = score; best = c; }
    }

    // DIAG: in top 3 ứng viên theo điểm để soi vì sao chọn mục này.
    const top = [...catNorm].sort((a, b) => b._score - a._score).slice(0, 3)
      .map((c) => `${c.name}=${c._score}`).join(" | ");
    blog(`DIAG map "${p.name}" (norm="${target}") -> chọn "${best && best.name}" | top: ${top}`);

    if (best && bestScore >= 2) {
      // GIÁ: ưu tiên GIÁ CATALOG (giá niêm yết chuẩn, khớp giá nhanh.vn tự điền).
      // Giá trích từ chat (p.price) hay sai: khách/shop ghi nhầm, hoặc bị tính
      // ngược từ COD (vd COD 219k / 3 = 73k trong khi giá thật 79k) -> khiến
      // tổng tiền hàng & chiết khấu lệch. Chỉ dùng p.price khi catalog KHÔNG có giá.
      const catalogPrice = Number(best.price) || 0;
      const extractedPrice = Number(p.price) || 0;
      // Với đơn dán test thủ công, giá ghi ngay trong nội dung là giá cần kiểm thử.
      // Các luồng chat tự động vẫn ưu tiên giá CATALOG như trước.
      const price = preserveExtractedPrices && extractedPrice > 0
        ? extractedPrice
        : (catalogPrice > 0 ? catalogPrice : extractedPrice);
      if (!(preserveExtractedPrices && extractedPrice > 0)
          && catalogPrice > 0 && extractedPrice > 0 && extractedPrice !== catalogPrice) {
        blog(`DIAG giá "${best.name}": dùng GIÁ CATALOG ${catalogPrice} (bỏ giá trích ${extractedPrice}).`);
      }
      // Giữ riêng giá ghi rõ trong nội dung đơn nếu khác catalog.
      // Giá thường vẫn dùng catalog; content script chỉ ghi đè ô Giá khi overridePrice > 0.
      const overridePrice = extractedPrice > 0 && catalogPrice > 0 && extractedPrice !== catalogPrice
        ? extractedPrice
        : 0;
      if (overridePrice) {
        blog(`DIAG giá khác catalog cho "${best.name}": catalog=${catalogPrice}, giá đơn=${overridePrice}; sẽ cập nhật ô Giá sau khi thêm sản phẩm.`);
      }
      return {
        quantity: p.quantity || 1,
        name: best.name,                       // tên NGUYÊN VĂN trong CATALOG
        search: best.search || best.name,      // TỪ KHÓA tìm ra duy nhất sản phẩm
        price,
        overridePrice
      };
    }
    return p; // không map được -> giữ nguyên
  });
}

// Có dòng sản phẩm nào là COMBO cần tách (chứa gợi ý nhiều món) không?
function productsNeedExpand(products) {
  if (!Array.isArray(products)) return false;
  return products.some((p) => {
    const n = (p.name || "");
    // Dấu hiệu combo: có "combo", hoặc có ngoặc liệt kê "(2 ... , 1 ...)", hoặc nhiều số trong ngoặc.
    return /combo/i.test(n) || /\([^)]*\d[^)]*,[^)]*\)/.test(n) || /\(\s*\d+\s*[^)]+\)/.test(n);
  });
}

// Dùng DeepSeek tách combo -> danh sách sản phẩm đơn lẻ, map tên chuẩn theo CATALOG.
async function expandProductsWithAI({ apiToken, model, products, catalog, totalCOD, shippingFee }) {
  const catalogText = catalog
    ? `\nDANH MỤC SẢN PHẨM CHUẨN (CATALOG) - BẮT BUỘC map tên sản phẩm về đúng một tên trong danh sách này:\n${catalog}\n`
    : "\n(Không có CATALOG - giữ tên mô tả rõ nhất có thể.)\n";

  const prompt = `Bạn tách các dòng sản phẩm (có thể là COMBO) thành danh sách sản phẩm ĐƠN LẺ cho đơn hàng.

Dữ liệu dòng sản phẩm gốc (JSON):
${JSON.stringify(products)}

Tổng COD = ${totalCOD || 0}, phí ship = ${shippingFee || 0}.
${catalogText}
Yêu cầu:
- Nếu một dòng là combo kiểu "1 x Combo 3 túi ... (2 Cay Vừa, 1 Không Cay)" thì tách thành từng sản phẩm đơn lẻ với đúng số lượng: 2 x <tên chuẩn Cay Vừa>, 1 x <tên chuẩn Không Cay>.
- BẮT BUỘC map mỗi vị/sản phẩm về đúng MỘT tên trong CATALOG (so khớp gần đúng, bỏ hoa thường/dấu). TUYỆT ĐỐI KHÔNG bịa tên ngoài CATALOG.
- Quy ước đặc biệt: "Siêu chà bông" hoặc "chà bông gạo thường" = dòng "Cơm cháy Gạo Thường" (chọn đúng vị Cay Vừa/Siêu Cay/Không Cay); loại 250g mặc định nếu không nói "Siêu Đại/500g".
- Giá mỗi dòng là ĐƠN GIÁ gốc theo CATALOG. Nếu không khớp được CATALOG, để price 0.
- Giữ nguyên các dòng không phải combo (vẫn map về CATALOG).

Trả về DUY NHẤT JSON:
{ "products": [ { "quantity": số, "name": "tên ĐÚNG NGUYÊN VĂN trong CATALOG", "price": số } ] }`;

  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiToken },
    body: JSON.stringify({
      model: model || "deepseek-chat",
      messages: [
        { role: "system", content: "Bạn chỉ trả lời bằng JSON hợp lệ." },
        { role: "user", content: prompt }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    })
  });

  if (!resp.ok) {
    const tx = await resp.text().catch(() => "");
    throw new Error(`DeepSeek expand ${resp.status}: ${tx.slice(0, 150)}`);
  }
  const data = await resp.json();
  saveUsage(data?.usage, model);
  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(content);
  return Array.isArray(parsed.products) ? parsed.products : products;
}

/* ============== THU THẬP & ĐIỀN QUA CÁC FRAME ============== */

function blog(...args) {
  console.log("[DS-Fill BG]", ...args);
}

async function getFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (frames && frames.length) {
    blog(`Tab ${tabId} có ${frames.length} frame:`);
    frames.forEach((f) => blog(`  frameId=${f.frameId} url=${(f.url || "").slice(0, 70)}`));
    return frames.map((f) => ({ frameId: f.frameId, url: f.url || "" }));
  }
  blog("Không lấy được danh sách frame, dùng [0].");
  return [{ frameId: 0, url: "" }];
}

// Sắp xếp để frame tạo đơn (crmadd) được xử lý TRƯỚC.
function orderFramesFirst(frames) {
  return [...frames].sort((a, b) => {
    const ai = /crmadd/i.test(a.url) ? 0 : 1;
    const bi = /crmadd/i.test(b.url) ? 0 : 1;
    return ai - bi;
  });
}

async function getFrameIds(tabId) {
  return (await getFrames(tabId)).map((f) => f.frameId);
}

// Gửi message tới 1 frame; nếu frame chưa có content script (lỗi "Receiving end
// does not exist"), tự inject content.js rồi thử lại.
async function sendToFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (e) {
    const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(e.message || "");
    if (!noReceiver) throw e;
    // Thử inject content.js vào frame rồi gửi lại.
    try {
      blog(`frame ${frameId}: chưa có content script -> inject runtime...`);
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["content.js"]
      });
      await new Promise((r) => setTimeout(r, 300));
      return await chrome.tabs.sendMessage(tabId, message, { frameId });
    } catch (e2) {
      blog(`frame ${frameId}: inject thất bại (${e2.message}).`);
      throw e2;
    }
  }
}

async function collectFromFrames(tabId, msgCount) {
  let best = { messages: [], orderConfirmation: "" };
  for (const frameId of await getFrameIds(tabId)) {
    try {
      const res = await sendToFrame(tabId, frameId, { type: "COLLECT_MESSAGES", msgCount });
      if (res && Array.isArray(res.messages)) {
        blog(`frame ${frameId}: thu được ${res.messages.length} tin, có xác nhận đơn = ${!!res.orderConfirmation}`);
        if (res.messages.length > best.messages.length) best.messages = res.messages;
        if (res.orderConfirmation && !best.orderConfirmation) best.orderConfirmation = res.orderConfirmation;
      }
    } catch (e) {
      blog(`frame ${frameId}: không phản hồi COLLECT_MESSAGES (${e.message}).`);
    }
  }
  blog(`Tổng hợp: ${best.messages.length} tin, orderConfirmation = ${best.orderConfirmation ? "CÓ" : "không"}`);
  return best;
}

// Click tab "Đơn hàng" ở bất kỳ frame nào có tab đó (chuyển từ màn Chat sang form).
async function openOrderTab(tabId) {
  let clickedAny = false;
  for (const frameId of await getFrameIds(tabId)) {
    try {
      const res = await sendToFrame(tabId, frameId, { type: "OPEN_ORDER_TAB" });
      blog(`frame ${frameId}: OPEN_ORDER_TAB -> clicked = ${res?.clicked}`);
      if (res && res.clicked) clickedAny = true;
    } catch (e) {
      blog(`frame ${frameId}: không phản hồi OPEN_ORDER_TAB.`);
    }
  }
  return clickedAny;
}

async function fillForm(tabId, extracted, options = {}) {
  // Ưu tiên frame crmadd trước để không điền nhầm vào trang chat.
  const frames = orderFramesFirst(await getFrames(tabId));
  for (const { frameId } of frames) {
    try {
      const res = await sendToFrame(tabId, frameId, { type: "FILL_FORM", data: extracted, mode: options.mode || "manual" });
      blog(`frame ${frameId}: FILL_FORM -> ${JSON.stringify(res)}`);
      if (res && res.filled) return res;
    } catch (e) {
      blog(`frame ${frameId}: không phản hồi FILL_FORM.`);
    }
  }
  return { filled: false, info: "Không tìm thấy form đơn hàng ở frame nào." };
}

/* ============== LUỒNG CHÍNH ============== */

async function runFill(tabId, options = {}) {
  const mode = options.mode || "manual";
  blog("=== BẮT ĐẦU RUN_FILL cho tab", tabId, "mode =", mode, "===");
  const cfg = await chrome.storage.local.get({
    apiToken: "", model: "deepseek-chat", msgCount: "3", catalog: "",
    promoHCM: "", promoOther: "", hcmProvinces: ""
  });

  const msgCount = Math.min(parseInt(cfg.msgCount, 10) || 3, 10);
  let collected = { messages: [], orderConfirmation: "" };
  let extracted = null;

  // Chế độ test thủ công: parse trực tiếp nội dung người dùng dán, không cần đọc chat/DeepSeek.
  if (options.orderText) {
    blog("Manual test: parse nội dung đơn được dán.");
    extracted = parseOrderConfirmation(options.orderText);
    if (!extracted) throw new Error("Không phân tích được đơn. Kiểm tra các trường Người nhận, Số điện thoại, Địa chỉ và Sản phẩm.");
    extracted._source = "manual-test";
  } else {
    blog("Thu thập chat, msgCount =", msgCount);
    collected = await collectFromFrames(tabId, msgCount);
    if (!collected.messages.length && !collected.orderConfirmation) {
      throw new Error("Không đọc được tin nhắn chat nào. Hãy mở màn hình có khung chat.");
    }
    // Chặn trước khi gọi AI hoặc mở/điền form.
    if (hasRecentStopPhrase(collected.messages, msgCount)) {
      throw new Error("Một trong 3 tin nhắn gần nhất có dấu hiệu tracking/tin CSKH của Bếp; đã hủy thao tác lên đơn.");
    }
  }

  // Gửi cho AI chỉ danh sách TÊN hiển thị (bỏ "::từ khóa" và giá) để model
  // map tên sản phẩm, tránh nhiễu bởi cú pháp nội bộ.
  const catalogRaw = (cfg.catalog && cfg.catalog.trim()) ? cfg.catalog : DEFAULT_CATALOG;
  const catalogForAI = parseCatalog(catalogRaw).map((c) => c.name).join("\n");
  // NHÁNH A: có khối "XÁC NHẬN ĐƠN HÀNG" -> parse bằng JS (nhanh, chính xác, miễn phí).
  if (!extracted && collected.orderConfirmation) {
    blog("NHÁNH A: tìm thấy khối xác nhận đơn -> parse bằng JS.");
    blog("DIAG orderConfirmation RAW =", JSON.stringify(collected.orderConfirmation));
    extracted = parseOrderConfirmation(collected.orderConfirmation);
    if (extracted) blog("Parse JS OK:", JSON.stringify(extracted));
  }

  // NHÁNH B: không có khối xác nhận -> DeepSeek phân tích hội thoại,
  // tự suy ra format xác nhận (SĐT, địa chỉ, sản phẩm, tổng COD).
  if (!extracted) {
    if (!cfg.apiToken) {
      throw new Error("Không có khối 'XÁC NHẬN ĐƠN HÀNG' và chưa cấu hình API Token DeepSeek.");
    }
    blog("NHÁNH B: không có khối xác nhận -> gọi DeepSeek phân tích hội thoại.");
    extracted = await callDeepSeek({
      apiToken: cfg.apiToken, model: cfg.model, messages: collected.messages, catalog: catalogForAI
    });
    blog("DeepSeek trả về:", JSON.stringify(extracted));

    // ƯU TIÊN REGEX: nếu tách được sản phẩm NGUYÊN VĂN từ hội thoại thì dùng
    // luôn (giữ đúng dòng gạo/vị cay khách chốt), tránh DeepSeek suy diễn sai.
    // Chỉ override khi regex ra số dòng BẰNG hoặc NHIỀU hơn AI (đủ tin cậy).
    const regexProducts = extractProductsFromMessages(collected.messages);
    if (regexProducts.length) {
      const aiCount = Array.isArray(extracted.products) ? extracted.products.length : 0;
      if (regexProducts.length >= aiCount) {
        blog(`Regex tách SP: dùng ${regexProducts.length} SP từ hội thoại (AI: ${aiCount}).`,
          JSON.stringify(regexProducts));
        extracted.products = regexProducts;
      } else {
        blog(`Regex tách SP: ${regexProducts.length} SP < AI ${aiCount} -> giữ của AI.`);
      }
    }
  }

  blog("Dữ liệu trích xuất:", JSON.stringify(extracted));

  // Nếu sản phẩm có COMBO cần tách, nhờ DeepSeek phân rã + map tên chuẩn theo CATALOG.
  if (cfg.apiToken && productsNeedExpand(extracted.products)) {
    blog("Phát hiện COMBO -> gọi DeepSeek tách sản phẩm...");
    try {
      const expanded = await expandProductsWithAI({
        apiToken: cfg.apiToken, model: cfg.model,
        products: extracted.products,
        catalog: catalogForAI, // chỉ tên hiển thị, đã làm sạch
        totalCOD: extracted.totalCOD, shippingFee: extracted.shippingFee
      });
      if (Array.isArray(expanded) && expanded.length) {
        blog("Sản phẩm sau khi tách:", JSON.stringify(expanded));
        extracted.products = expanded;
      }
    } catch (e) {
      blog("Tách combo lỗi (giữ nguyên sản phẩm gốc):", e.message);
    }
  } else if (productsNeedExpand(extracted.products)) {
    blog("CẢNH BÁO: có combo nhưng chưa cấu hình API Token -> không tách được.");
  }

  // Ép tên sản phẩm về đúng NGUYÊN VĂN trong CATALOG (dù nguồn nào) để tìm kiếm chính xác.
  // Dùng CATALOG mặc định nếu config trống.
  const catalogList = parseCatalog(cfg.catalog && cfg.catalog.trim() ? cfg.catalog : DEFAULT_CATALOG);
  if (catalogList.length && Array.isArray(extracted.products)) {
    const before = extracted.products.map((p) => `${p.quantity}x ${p.name}`).join("; ");
    extracted.products = mapProductsToCatalog(extracted.products, catalogList, extracted._source === "manual-test");
    const after = extracted.products.map((p) => `${p.quantity}x ${p.name} (${p.price})`).join("; ");
    blog(`Map CATALOG: [${before}] -> [${after}]`);
  }

  // Bỏ hậu tố trọng lượng dạng " (250g)" khỏi tên/từ khóa sản phẩm (nếu còn).
  // Catalog không chứa "(250g)" nên tên này chỉ thừa; loại bỏ để khớp & tìm chính xác.
  if (Array.isArray(extracted.products)) {
    extracted.products = extracted.products.map((p) => ({
      ...p,
      name: stripWeightSuffix(p.name),
      search: p.search != null ? stripWeightSuffix(p.search) : p.search
    }));
  }

  // Chuẩn hóa đơn vị tiền tệ: DeepSeek đôi khi rút gọn "219K" -> 219.
  // Dùng giá sản phẩm (đã lấy từ CATALOG, đơn vị VND đầy đủ) làm mốc để
  // phát hiện & khôi phục các trường tiền bị thiếu số 0 (nhân 1000).
  normalizeMoneyFields(extracted);

  // Chuẩn hóa địa chỉ: THỬ JS TRƯỚC (nhanh, miễn phí); chỉ gọi DeepSeek nếu
  // địa chỉ "thập cẩm"/thiếu cấu trúc (JS không tách ra Phường + Tỉnh rõ ràng).
  if (addressNeedsAI(extracted) && cfg.apiToken) {
    const rawAddr = [extracted.address, extracted.addressRegion].filter(Boolean).join(", ");
    blog("Địa chỉ chưa chuẩn -> gọi DeepSeek chuẩn hóa:", rawAddr);
    try {
      const norm = await normalizeAddressWithAI({ apiToken: cfg.apiToken, model: cfg.model, rawAddress: rawAddr });
      blog("Chuẩn hóa địa chỉ (AI):", JSON.stringify(norm));
      if (norm && (norm.ward || norm.province)) {
        extracted.address = norm.detail || extracted.address;
        const normalizedRegion = [norm.ward, norm.district, norm.province].filter(Boolean).join(", ");
        extracted.addressRegion = removeObsoleteHcmDistricts(normalizedRegion);

        // Bản 2 cấp phải luôn giữ 2 cụm có ý nghĩa:
        // - Có phường/xã: Phường/Xã + Tỉnh/Thành phố.
        // - Chưa xác định được phường/xã nhưng có quận/huyện: Quận/Huyện + Tỉnh/Thành phố.
        // Tránh lỗi AI trả norm.ward rỗng khiến addressRegion2 chỉ còn "Hà Nội".
        const twoLevelParts = norm.ward
          ? [norm.ward, norm.province]
          : norm.district
            ? [norm.district, norm.province]
            : [];
        const twoLevelRegion = twoLevelParts.filter(Boolean).join(", ")
          || buildTwoLevelRegion(extracted.addressRegion);
        extracted.addressRegion2 = removeObsoleteHcmDistricts(twoLevelRegion);
      }
    } catch (e) {
      blog("Chuẩn hóa địa chỉ lỗi (giữ nguyên):", e.message);
    }
  } else {
    // JS đã tách đủ -> tạo sẵn bản 2 cấp (bỏ cấp Quận/Huyện ở giữa).
    extracted.addressRegion2 = buildTwoLevelRegion(extracted.addressRegion);
    blog(`Địa chỉ đã chuẩn (JS). 3 cấp="${extracted.addressRegion}", 2 cấp="${extracted.addressRegion2}"`);
  }

  // Xác định mã khuyến mại HVC theo địa chỉ: HCM (hoặc tỉnh lân cận cấu hình) hay ngoại tỉnh.
  const regionText = (extracted.addressRegion || "") + " " + (extracted.address || "");
  const isHCM = isHcmLikeRegion(regionText, cfg.hcmProvinces);
  const promoCode = isHCM ? (cfg.promoHCM || "") : (cfg.promoOther || "");
  if (promoCode) {
    extracted.promoCode = promoCode;
    blog(`Mã KM: địa chỉ ${isHCM ? "HCM/lân cận" : "ngoại tỉnh"} -> "${promoCode}"`);
  } else {
    blog(`Mã KM: ${isHCM ? "HCM/lân cận" : "ngoại tỉnh"} nhưng chưa cấu hình -> bỏ qua.`);
  }

  // Chuyển sang tab "Đơn hàng" (nếu đang ở màn Chat) rồi chờ form + API load (~3s).
  blog("Mở tab Đơn hàng...");
  await openOrderTab(tabId);
  blog("Chờ 3s để form load dữ liệu từ API...");
  await new Promise((r) => setTimeout(r, 3000));

  blog("Bắt đầu điền form...");
  const fillRes = await fillForm(tabId, extracted, { mode });

  // Gỡ debugger (nếu đã attach khi click mã KM) để tắt thanh cảnh báo.
  await detachDebugger(tabId);

  const summary = [
    "Nguồn: " + (extracted._source === "manual-test" ? "Test thủ công" : extracted._source === "confirmation" ? "Khối xác nhận đơn" : "DeepSeek AI"),
    extracted.name ? "Tên: " + extracted.name : null,
    extracted.phone ? "SĐT: " + extracted.phone : null,
    extracted.address ? "Địa chỉ: " + extracted.address : null,
    extracted.products?.length ? "SP: " + extracted.products.map(p => `${p.quantity}x ${p.name}`).join("; ") : null,
    extracted.totalCOD ? "Tổng COD: " + extracted.totalCOD : null
  ].filter(Boolean).join("\n");

  if (!fillRes.filled) {
    const info = fillRes.info || "Không điền được form.";
    return {
      ok: false,
      filled: false,
      error: info,
      reviewRequired: mode === "webhook",
      summary: summary + "\n\n(Đã trích nhưng chưa điền được form: " + info + ")"
    };
  }
  // Giữ nguyên kết quả từ iframe. fillOrderByPhone cần reviewRequired để không đóng
  // tab khi webhook chỉ điền form mà chưa được phép tự lưu.
  return {
    ok: true,
    filled: true,
    reviewRequired: !!fillRes.reviewRequired,
    submitted: !!fillRes.submitted,
    summary: summary + "\n" + (fillRes.info || "")
  };
}

// Click chuột THẬT qua chrome.debugger (isTrusted=true) tại tọa độ (x,y) viewport tab.
async function debuggerClick(tabId, x, y) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    if (!/already attached/i.test(e.message || "")) {
      blog("debugger.attach lỗi:", e.message);
      return { ok: false, error: e.message };
    }
  }
  try {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
    await new Promise((r) => setTimeout(r, 60));
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await new Promise((r) => setTimeout(r, 60));
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return { ok: true };
  } catch (e) {
    blog("debuggerClick lỗi:", e.message);
    return { ok: false, error: e.message };
  }
}

async function detachDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

// Lấy offset (vị trí trái/trên) của iframe crmadd2 trong trang top.
async function getIframeOffset(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "GET_IFRAME_OFFSET" }, { frameId: 0 });
    if (res && typeof res.x === "number") return { x: res.x, y: res.y };
  } catch (e) {
    blog("getIframeOffset lỗi:", e.message);
  }
  return { x: 0, y: 0 };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "RUN_FILL") {
    runFill(msg.tabId)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "RUN_TEST_ORDER") {
    (async () => {
      const tabs = await chrome.tabs.query({ url: "https://vpage.nhanh.vn/*" });
      const tab = tabs.find((t) => t.url && /conversation/i.test(t.url)) || tabs[0];
      if (!tab?.id) throw new Error("Hãy mở và đăng nhập Vpage trước, sau đó bấm test lại.");
      return await runFill(tab.id, { mode: "test", orderText: msg.orderText });
    })().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "CHECK_ACCOUNT") {
    checkAccount(msg.apiToken)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "DEBUGGER_CLICK") {
    // msg.x, msg.y là tọa độ TRONG IFRAME. Cần cộng offset iframe (lấy từ frame top).
    const tabId = sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "no tab" }); return true; }
    (async () => {
      const off = await getIframeOffset(tabId);
      const x = msg.x + off.x;
      const y = msg.y + off.y;
      blog(`DEBUGGER_CLICK: trong-iframe (${Math.round(msg.x)},${Math.round(msg.y)}) + offset (${Math.round(off.x)},${Math.round(off.y)}) = (${Math.round(x)},${Math.round(y)})`);
      const r = await debuggerClick(tabId, x, y);
      sendResponse(r);
    })();
    return true;
  }
  if (msg?.type === "DEBUGGER_DETACH") {
    const tabId = sender?.tab?.id;
    if (tabId) detachDebugger(tabId);
    sendResponse({ ok: true });
    return true;
  }
});


/* ============== TELEGRAM + QUÉT TỰ ĐỘNG ============== */

// Gửi tin nhắn Telegram (có thể kèm nút inline "Lên đơn").
async function tgSend(token, chatId, text, replyMarkup) {
  if (!token || !chatId) return { ok: false, error: "Thiếu token/chatId" };
  try {
    const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.description || ("HTTP " + resp.status) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Tìm tab conversation của vpage (để quét DOM hội thoại).
async function findConversationTab() {
  const tabs = await chrome.tabs.query({ url: "https://vpage.nhanh.vn/*" });
  return tabs && tabs.length ? tabs[0] : null;
}

// Liệt kê hội thoại theo chế độ: "unread" = chưa đọc; "recent5" = 5 box gần nhất bất kể trạng thái đọc.
async function listConversations(tabId, scanMode = "unread", recentCount = 5) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: function (mode, count) {
        const selector = mode === "recent5" ? ".item.position-relative" : ".item.position-relative.unread";
        const limit = Math.max(1, Math.min(50, Number.parseInt(count, 10) || 5));
        const items = Array.from(document.querySelectorAll(selector))
          .filter((el) => el.offsetParent !== null)
          .slice(0, mode === "recent5" ? limit : 5);
        const out = [];
        items.forEach((it, idx) => {
          const name = (it.querySelector("b.name")?.innerText
            || it.querySelector(".name")?.innerText
            || it.querySelector("b")?.innerText || "").trim();
          const a = it.querySelector("a[href]");
          const timeTitle = it.querySelector(".conv-time[title]")?.getAttribute("title") || "";
          const timeMatch = timeTitle.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
          const activityAt = timeMatch
            ? new Date(Number(timeMatch[3]), Number(timeMatch[2]) - 1, Number(timeMatch[1]), Number(timeMatch[4]), Number(timeMatch[5]), Number(timeMatch[6])).getTime()
            : 0;
          const id = it.getAttribute("data-id")
            || it.getAttribute("data-conversation-id")
            || it.getAttribute("data-cid")
            || it.id
            || (a && a.getAttribute("href"))
            || (name ? `name:${name}` : `idx:${idx}`);
          out.push({ id, name, activityAt });
        });
        return { list: out, total: items.length };
      },
      args: [scanMode, recentCount]
    });
    const r = (results && results[0] && results[0].result) || { list: [] };
    blog(`listConversations: chế độ ${scanMode}, lấy ${r.total} box gần nhất (tối đa ${scanMode === "recent5" ? Math.max(1, Math.min(50, parseInt(recentCount, 10) || 5)) : 5}).`);
    return r.list || [];
  } catch (e) {
    blog("listConversations lỗi:", e.message);
    return [];
  }
}

// Click mở hội thoại theo khóa ổn định; recent5 tìm trong tất cả box vì khi mở, box có thể chuyển trạng thái đã đọc.
async function openConversationById(tabId, convId, scanMode = "unread") {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: function (wantId, mode) {
        const selector = mode === "recent5" ? ".item.position-relative" : ".item.position-relative.unread";
        const items = Array.from(document.querySelectorAll(selector))
          .filter((el) => el.offsetParent !== null);
        const idOf = (it, idx) => {
          const a = it.querySelector("a[href]");
          const name = (it.querySelector("b.name")?.innerText
            || it.querySelector(".name")?.innerText
            || it.querySelector("b")?.innerText || "").trim();
          return it.getAttribute("data-id")
            || it.getAttribute("data-conversation-id")
            || it.getAttribute("data-cid")
            || it.id
            || (a && a.getAttribute("href"))
            || (name ? `name:${name}` : `idx:${idx}`);
        };
        let el = null;
        items.forEach((it, idx) => { if (!el && idOf(it, idx) === wantId) el = it; });
        if (!el) return { ok: false };
        el.scrollIntoView({ block: "center" });
        const target = el.querySelector(".info, .content, b.name, .name") || el;
        const opts = { bubbles: true, cancelable: true, view: window };
        try { target.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) {}
        target.dispatchEvent(new MouseEvent("mousedown", opts));
        target.dispatchEvent(new MouseEvent("mouseup", opts));
        target.dispatchEvent(new MouseEvent("click", opts));
        if (typeof el.click === "function") el.click();
        return { ok: true };
      },
      args: [convId, scanMode]
    });
    return !!(results && results[0] && results[0].result && results[0].result.ok);
  } catch (e) {
    blog("openConversationById lỗi:", e.message);
    return false;
  }
}

// Hỏi content script: trong N tin GẦN NHẤT (từ dưới lên) có tin SHOP nào là
// khối đơn hàng không? Thử ở mọi frame (khung chat có thể là iframe).
// Trả text đầy đủ hoặc "".
async function getShopOrderText(tabId, lastN = 3) {
  for (const frameId of await getFrameIds(tabId)) {
    try {
      const res = await sendToFrame(tabId, frameId, { type: "COLLECT_SHOP_ORDER", lastN });
      if (res && res.orderText) return res.orderText;
    } catch (_) {}
  }
  return "";
}

// Lấy N tin nhắn gần nhất để cảnh báo Telegram khi AI chưa kịp tạo template chốt đơn.
async function getRecentConversationMessages(tabId, lastN = 3) {
  for (const frameId of await getFrameIds(tabId)) {
    try {
      const res = await sendToFrame(tabId, frameId, { type: "COLLECT_RECENT_MESSAGES", lastN });
      if (res && Array.isArray(res.messages) && res.messages.length) return res.messages;
    } catch (_) {}
  }
  return [];
}

// Chỉ gửi cảnh báo dự phòng khi có tin KHÁCH chứa cả số điện thoại và dấu hiệu địa chỉ.
// Không tự động lên đơn từ tin nhắn thô.
function findCustomerContactMessage(messages) {
  const recent = Array.isArray(messages) ? messages : [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i] || {};
    if (m.role !== "customer" && m.role !== "client" && m.role !== "khach") continue;
    const t = String(m.text || "").trim();
    const phone = t.match(/(?:\+?84|0)\d(?:[\s.-]?\d){8,10}/);
    const hasAddress = /(địa chỉ|\bphường\b|\bxã\b|\bquận\b|\bhuyện\b|\bấp\b|\bthôn\b|\bđường\b|\bchung cư\b)/i.test(t);
    if (phone && hasAddress) return { text: t, phone: phone[0].replace(/\D/g, ""), sender: m.sender || "" };
  }
  return null;
}

// Định dạng khối đơn hàng thành nội dung Telegram ĐẦY ĐỦ.
// - Phần trên: các trường đã parse (đẹp, có emoji) để dễ đọc nhanh.
// - Phần dưới: NGUYÊN VĂN khối đơn shop đã nhắn, đảm bảo KHÔNG sót thông tin
//   nào (mã đơn, hình thức thanh toán, ghi chú... dù parser chưa tách riêng).
function formatOrderForTelegram(parsed, conversationName, rawText, orderUrl) {
  const fmt = (n) => (Number(n) || 0).toLocaleString("vi-VN");
  const lines = [];
  lines.push("🛎 <b>ĐƠN MỚI CHỐT</b>");
  if (conversationName) lines.push(`💬 Hội thoại: ${escapeHtml(conversationName)}`);
  lines.push("");

  if (parsed) {
    if (parsed.name) lines.push(`👤 <b>Tên người nhận:</b> ${escapeHtml(parsed.name)}`);
    if (parsed.phone) lines.push(`📞 <b>Số điện thoại:</b> ${escapeHtml(parsed.phone)}`);
    const fullAddr = [parsed.address, parsed.addressRegion].filter(Boolean).join(", ");
    if (fullAddr) lines.push(`📍 <b>Địa chỉ:</b> ${escapeHtml(fullAddr)}`);
    if (Array.isArray(parsed.products) && parsed.products.length) {
      lines.push(`🛒 <b>Sản phẩm:</b>`);
      for (const p of parsed.products) {
        const price = Number(p.price) ? ` - ${fmt(p.price)}` : "";
        lines.push(`   • ${p.quantity} x ${escapeHtml(p.name)}${price}`);
      }
    }
    if (parsed.shippingFee != null) lines.push(`🚚 <b>Phí vận chuyển:</b> ${fmt(parsed.shippingFee)}`);
    if (Number(parsed.discount)) lines.push(`🏷 <b>Chiết khấu:</b> ${fmt(parsed.discount)}`);
    if (parsed.totalCOD != null) lines.push(`💰 <b>Tổng:</b> ${fmt(parsed.totalCOD)}`);
  }

  // Link lên đơn (kèm SĐT) - để bấm mở đúng hội thoại và cho trigger tự động.
  if (orderUrl) {
    lines.push("");
    lines.push(`🔗 <a href="${escapeHtml(orderUrl)}">Mở hội thoại để lên đơn</a>`);
  }

  // Luôn kèm nguyên văn khối đơn để đảm bảo gửi ĐỦ mọi thông tin.
  if (rawText && rawText.trim()) {
    lines.push("");
    lines.push("📋 <b>Chi tiết đầy đủ:</b>");
    lines.push(`<pre>${escapeHtml(rawText.trim())}</pre>`);
  }

  // Telegram giới hạn 4096 ký tự/tin -> cắt an toàn nếu quá dài.
  let out = lines.join("\n");
  if (out.length > 4000) out = out.slice(0, 3990) + "\n…";
  return out;
}

// Chạy 1 lượt quét: mở LẦN LƯỢT các hội thoại CHƯA ĐỌC, nếu tin GẦN NHẤT bên
// SHOP là khối đơn hàng thì gửi NỘI DUNG ĐẦY ĐỦ về Telegram (chống trùng theo SĐT).
async function runScanCycle() {
  const cfg = await chrome.storage.local.get({
    tgEnabled: false, tgToken: "", tgChatId: "", msgCount: "3", tgMsgCount: 3, scanMode: "unread", scanStrategy: "fixed", scanBaselineAt: 0,
    autoFillEnabled: false, autoOrderOnNotify: false, autoSubmitOrder: false, workerUrl: ""
  });
  if (!cfg.tgEnabled) {
    blog("Quét bỏ qua: tùy chọn tự động quét Telegram đang tắt (tgEnabled=false).");
    return;
  }
  if (!cfg.tgToken || !cfg.tgChatId) {
    blog("Quét bỏ qua: chưa cấu hình Telegram Bot Token hoặc Chat ID.");
    return;
  }

  // Số tin GẦN NHẤT cần đọc trong mỗi hội thoại (từ dưới lên). Mặc định 3.
  const lastN = Math.min(Math.max(parseInt(cfg.tgMsgCount, 10) || 3, 1), 10);

  const tab = await findConversationTab();
  if (!tab) { blog("Quét: không có tab vpage mở -> bỏ qua."); return; }

  // Chọn danh sách theo cấu hình: chỉ chưa đọc (mặc định) hoặc 5 box gần nhất.
  const scanMode = cfg.scanMode === "recent5" ? "recent5" : "unread";
  const recentCount = Math.max(1, Math.min(50, parseInt(cfg.scanRecentCount, 10) || 5));
  const incremental = cfg.scanStrategy === "incremental" && scanMode === "recent5";
  let conversations = await listConversations(tab.id, scanMode, incremental ? 50 : recentCount);
  let checkpointAt = 0;
  if (incremental) {
    const checkpoint = await chrome.storage.local.get({ scanActivityCheckpoint: 0 });
    checkpointAt = Number(checkpoint.scanActivityCheckpoint) || Number(cfg.scanBaselineAt) || 0;
    if (checkpointAt > 0) {
      const overlapMs = 2 * 60 * 1000;
      conversations = conversations.filter((conv) => conv.activityAt > 0 && conv.activityAt >= checkpointAt - overlapMs);
      blog(`Incremental scan: mốc=${new Date(checkpointAt).toLocaleString("vi-VN")}, cửa sổ đệm 2 phút, còn ${conversations.length} box cần kiểm tra.`);
    } else {
      blog("Incremental scan: chưa có mốc đã quét; dùng thời điểm lưu cấu hình làm mốc ban đầu.");
    }
  }
  blog(scanMode === "recent5"
    ? `Quét: ${conversations.length} box ${incremental ? "theo mốc hoạt động mới" : "gần nhất"} (bao gồm đã đọc/chưa đọc).`
    : `Quét: ${conversations.length} hội thoại CHƯA ĐỌC.`);
  if (!conversations.length) return;

  // Chống gửi trùng: lưu key (phone/text) đã thông báo (dọn mục > 24h).
  const st = await chrome.storage.local.get({ tgNotified: {} });
  const notified = st.tgNotified || {};
  const now = Date.now();
  for (const k of Object.keys(notified)) if (now - notified[k] > 86400000) delete notified[k];

  let scanned = 0, sent = 0;
  for (const conv of conversations) {
    scanned++;
    // 1) Click mở hội thoại (theo khóa ổn định).
    const opened = await openConversationById(tab.id, conv.id, scanMode);
    if (!opened) { blog(`Quét: không mở được hội thoại "${conv.name}".`); continue; }

    // 2) Chờ khung chat nạp tin nhắn (~2.5s).
    await new Promise((r) => setTimeout(r, 2500));

    // 3) Kiểm tra 3 tin mới nhất trước mọi luồng Telegram/tự lên đơn.
    // Nếu gặp tracking hoặc tin hệ thống/CSKH của Bếp thì bỏ qua hội thoại này ngay.
    const recentMessages = await getRecentConversationMessages(tab.id, lastN);
    if (hasRecentStopPhrase(recentMessages, lastN)) {
      blog(`Quét: "${conv.name}" - 3 tin mới nhất có "Theo dõi vận chuyển", "Thông báo từ Bếp" hoặc "Trân trọng"; dừng, không gửi Telegram và không tự lên đơn.`);
      continue;
    }

    // 4) Lấy khối đơn trong N tin GẦN NHẤT bên SHOP.
    const orderText = await getShopOrderText(tab.id, lastN);
    if (!orderText) {
      // Nếu 3 tin gần nhất chưa có template chốt đơn và cũng chưa có tracking,
      // vẫn báo Telegram khi khách đã gửi SĐT + địa chỉ để không bỏ sót lead.
      const contact = findCustomerContactMessage(recentMessages);
      if (!contact) {
        blog(`Quét: "${conv.name}" - chưa có template chốt đơn hoặc tin khách đủ SĐT + địa chỉ (hoặc đã có tracking).`);
        continue;
      }

      const fallbackKey = "contact:" + contact.phone;
      if (notified[fallbackKey]) {
        blog(`Quét: "${conv.name}" - cảnh báo khách ${contact.phone} đã gửi trước đó, bỏ qua.`);
        continue;
      }
      const fallbackText = [
        "⚠️ <b>KHÁCH ĐÃ GỬI SĐT + ĐỊA CHỈ, CHƯA THẤY TEMPLATE CHỐT ĐƠN</b>",
        `💬 Hội thoại: ${escapeHtml(conv.name)}`,
        contact.sender ? `👤 Người gửi: ${escapeHtml(contact.sender)}` : "",
        `📞 Số điện thoại: ${escapeHtml(contact.phone)}`,
        "",
        "📋 <b>Tin nhắn khách gửi:</b>",
        `<pre>${escapeHtml(contact.text)}</pre>`,
        "",
        "ℹ️ Có thể AI chưa kịp tạo đơn hoặc chốt đơn tự động bị lỗi. Vui lòng kiểm tra hội thoại."
      ].filter(Boolean).join("\n");
      const fallbackUrl = `https://vpage.nhanh.vn/app/conversation?customerName=${encodeURIComponent(contact.phone)}`;
      const fallbackButtons = [];
      // Có SĐT và đã cấu hình Worker thì hiện nút Lên đơn như thông báo đơn chuẩn.
      if (contact.phone && cfg.workerUrl) {
        fallbackButtons.push([{ text: "🧾 Lên đơn", callback_data: `fill:${contact.phone}` }]);
      }
      fallbackButtons.push([{ text: "💬 Mở hội thoại", url: fallbackUrl }]);
      const fallbackResult = await tgSend(cfg.tgToken, cfg.tgChatId, fallbackText, { inline_keyboard: fallbackButtons });
      if (fallbackResult.ok) {
        notified[fallbackKey] = now;
        sent++;
        blog(`Quét: "${conv.name}" - đã gửi cảnh báo dự phòng cho ${contact.phone}.`);
      } else {
        blog(`Quét: gửi cảnh báo dự phòng Telegram lỗi: ${fallbackResult.error}`);
      }
      continue;
    }

    // 4) Bỏ qua tin xác nhận đã có dấu hiệu đơn được tạo/xử lý trước đó.
    // Tin CSKH tự động kiểu "Em gửi đơn cho mình ạ" có thể còn nằm trong hội thoại
    // chưa đọc dù đơn đã được tạo; nếu có "Theo dõi vận chuyển" hoặc link tracking
    // thì không gửi Telegram và tuyệt đối không kích hoạt luồng tạo đơn lần nữa.
    const normalizedOrderText = normalizeTrackingText(orderText);
    const hasTrackingLink = /https?:\/\/(?:www\.)?nhanh\.vn\/tracking(?:[/?#]|$)/i.test(orderText);
    if (normalizedOrderText.includes("theo doi van chuyen") || hasTrackingLink) {
      blog(`Quét: "${conv.name}" - bỏ qua template vì đã có dấu hiệu tracking/đơn đã xử lý; không gửi Telegram, không lên đơn lại.`);
      continue;
    }

    // Parse để lấy thông tin + khóa chống trùng; nếu parse lỗi vẫn gửi text thô.
    const parsed = parseOrderConfirmation(orderText);
    const key = (parsed && parsed.phone) || orderText.slice(0, 120);
    if (notified[key]) { blog(`Quét: "${conv.name}" - đã gửi trước đó, bỏ qua.`); continue; }

    // Link mở đúng hội thoại để lên đơn (theo SĐT). Dùng cho nút "Lên đơn" và
    // sau này cho trigger lên đơn tự động.
    const phone = parsed && parsed.phone ? parsed.phone : "";
    const orderUrl = phone
      ? `https://vpage.nhanh.vn/app/conversation?customerName=${encodeURIComponent(phone)}`
      : "";

    // Gửi ĐẦY ĐỦ: trường đã parse + nguyên văn khối đơn + link lên đơn.
    const text = formatOrderForTelegram(parsed, conv.name, orderText, orderUrl);

    // Nút bấm:
    //  - "Mở hội thoại" (url): mở trực tiếp trên máy đang có extension.
    //  - "Lên đơn" (callback): bấm trên ĐIỆN THOẠI -> Telegram gọi webhook
    //    Worker -> Worker ghi lệnh {phone} vào KV -> extension poll /pull rồi
    //    lên đơn. Luôn hiện khi có SĐT và đã cấu hình Worker URL.
    const buttons = [];
    if (phone && cfg.workerUrl) {
      buttons.push([{ text: "🧾 Lên đơn", callback_data: `fill:${phone}` }]);
    } else {
      blog(`Nút Lên đơn bị ẩn: phone=${phone || "(trống)"}, workerUrl=${cfg.workerUrl ? "có" : "chưa cấu hình"}.`);
    }
    if (orderUrl) buttons.push([{ text: "💬 Mở hội thoại", url: orderUrl }]);
    const markup = buttons.length ? { inline_keyboard: buttons } : undefined;

    const r = await tgSend(cfg.tgToken, cfg.tgChatId, text, markup);
    if (r.ok) {
      notified[key] = now;
      sent++;
      blog(`Đã gửi TG đơn của "${conv.name}" (key=${key}).`);

      // Tùy chọn: tự lên đơn ngay khi đã gửi thông báo Telegram thành công,
      // không cần người dùng bấm nút inline "Lên đơn".
      if (cfg.autoOrderOnNotify && cfg.autoFillEnabled && phone) {
        try {
          blog(`AutoOrderOnNotify: tự động lên đơn cho ${phone} sau thông báo Telegram.`);
          const autoResult = await fillOrderByPhone(phone);
          blog(`AutoOrderOnNotify: kết quả lên đơn ${phone}: ${JSON.stringify(autoResult).slice(0, 300)}`);
        } catch (e) {
          blog(`AutoOrderOnNotify: lên đơn tự động lỗi cho ${phone}: ${e?.message || e}`);
        }
      } else if (cfg.autoOrderOnNotify && !cfg.autoFillEnabled) {
        blog("AutoOrderOnNotify đang bật nhưng nhận lệnh lên đơn tự động (autoFillEnabled) đang tắt; bỏ qua.");
      }
    } else blog(`Gửi TG lỗi cho "${conv.name}": ${r.error}`);

    // Nhịp nhẹ giữa các hội thoại.
    await new Promise((r) => setTimeout(r, 400));
  }
  const saveState = { tgNotified: notified };
  if (incremental) {
    const maxActivityAt = Math.max(0, ...conversations.map((conv) => Number(conv.activityAt) || 0));
    if (maxActivityAt > 0) saveState.scanActivityCheckpoint = Math.max(checkpointAt, maxActivityAt);
  }
  await chrome.storage.local.set(saveState);
  blog(`Quét xong: duyệt ${scanned}/${conversations.length} box (${scanMode === "recent5" ? `${recentCount} box gần nhất` : "chưa đọc"}), gửi ${sent} đơn mới.`);
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ============== POLL LỆNH LÊN ĐƠN TỰ ĐỘNG (Cloudflare Worker) ============== */

// Chờ 1 tab load xong (status === "complete").
function waitTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(true); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(false); }, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    // Phòng trường hợp đã complete sẵn.
    chrome.tabs.get(tabId, (t) => { if (t && t.status === "complete") done(); });
  });
}

// Click vào box hội thoại ĐẦU TIÊN (.item) trong danh sách bên trái của vpage.
// Sau khi điều hướng với ?customerName=<SĐT>, danh sách được lọc theo SĐT nên
// box đầu tiên chính là hội thoại của khách cần lên đơn. Trước khi click, kiểm
// tra text của item có chứa SĐT để tránh click nhầm khi danh sách chưa filter.
// Chờ box xuất hiện tối đa `timeout` ms. Trả tên hội thoại đã click hoặc "" nếu thất bại.
async function openFirstConversation(tabId, phone = "", timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: function () {
          const items = Array.from(document.querySelectorAll(".item"))
            .filter((el) => el.offsetParent !== null && el.querySelector("b.name, .name"));
          if (!items.length) return { ok: false, count: 0 };

          // URL đã lọc đúng khách hàng; chỉ cần click box hội thoại đầu tiên.
          const el = items[0];
          const name = (el.querySelector("b.name")?.innerText
            || el.querySelector(".name")?.innerText || "").trim();

          el.scrollIntoView({ block: "center" });
          const target = el.querySelector(".info") || el;
          target.click();

          return { ok: true, count: items.length, name };
        },
        args: []
      });

      const r = results && results[0] && results[0].result;
      if (r && r.ok) {
        blog(`AutoFill: đã click box đầu tiên "${r.name}" (trong ${r.count} box).`);
        return r.name || "(không tên)";
      }
    } catch (e) {
      blog("openFirstConversation lỗi:", e.message);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
}

// Mở/điều hướng tab vpage tới hội thoại theo SĐT rồi chạy lên đơn (runFill).
async function fillOrderByPhone(phone) {
  const targetUrl = `https://vpage.nhanh.vn/app/conversation?customerName=${encodeURIComponent(phone)}`;
  // Luôn dùng tab riêng; chế độ background không lấy focus khỏi tab người dùng.
  const cfg = await chrome.storage.local.get({ orderTabMode: "default" });
  const mode = ["background", "switch"].includes(cfg.orderTabMode) ? cfg.orderTabMode : "default";
  // Default: hành vi cũ (mở tab mới và chuyển focus ngay).
  // Background: tạo tab không active để người dùng tiếp tục tab đang làm.
  // Switch: cho tab đơn tải trước, sau đó mới chuyển focus sang Nhanh.vn.
  const activateImmediately = mode === "default";
  blog(`AutoFill: orderTabMode=${mode}; tạo tab đơn mới.`);
  const tab = await chrome.tabs.create({ url: targetUrl, active: activateImmediately });
  let keepTabForReview = false;
  try {
    await waitTabComplete(tab.id, 20000);
    if (mode === "switch") {
      await chrome.tabs.update(tab.id, { active: true });
      blog(`AutoFill: tab đơn #${tab.id} đã tải xong; chuyển focus sang Nhanh.vn.`);
    }
    await new Promise((r) => setTimeout(r, 4000));

    const opened = await openFirstConversation(tab.id, phone);
    if (!opened) throw new Error(`Không tìm thấy box hội thoại nào cho SĐT ${phone}.`);
    await new Promise((r) => setTimeout(r, 3000));

    blog(`AutoFill webhook: bắt đầu runFill cho tab mới #${tab.id} (SĐT ${phone}).`);
    const res = await runFill(tab.id, { mode: "webhook" });
    keepTabForReview = !!res?.reviewRequired || res?.ok === false || res?.filled === false;
    blog(`AutoFill webhook: runFill xong -> ${JSON.stringify(res).slice(0, 500)}`);
    return res;
  } finally {
    if (keepTabForReview) {
      blog(`AutoFill webhook: giữ tab riêng #${tab.id} mở để kiểm tra (chế độ chưa tự lưu).`);
    } else {
      try {
        await chrome.tabs.remove(tab.id);
        blog(`AutoFill webhook: đã đóng tab riêng #${tab.id}.`);
      } catch (e) {
        blog(`AutoFill webhook: không đóng được tab #${tab.id}: ${e.message}`);
      }
    }
  }
}

/* ============== PUSH LỆNH QUA WEBSOCKET ============== */
let _commandSocket = null;
let _socketReconnectTimer = null;
let _socketHeartbeat = null;
let _processingCommands = new Set();
function connectCommandSocket() {
  if (_commandSocket && (_commandSocket.readyState === WebSocket.OPEN || _commandSocket.readyState === WebSocket.CONNECTING)) return;
  chrome.storage.local.get({ workerUrl: "", pullSecret: "" }, (cfg) => {
    // Luôn giữ kênh điều khiển mở kể cả khi đã tắt nhận lệnh lên đơn,
    // để điện thoại có thể bật lại bằng /orders_on.
    if (!cfg.workerUrl || !cfg.pullSecret) return;
    try {
      const base = cfg.workerUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:").replace(/\/+$/, "");
      const ws = new WebSocket(base + "/ws?secret=" + encodeURIComponent(cfg.pullSecret));
      _commandSocket = ws;
      ws.onopen = () => {
        blog("Push: WebSocket đã kết nối; không polling KV.");
        if (_socketHeartbeat) clearInterval(_socketHeartbeat);
        _socketHeartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: "ping" })); } catch (_) {} } }, 20000);
      };
      ws.onmessage = (event) => { let msg; try { msg = JSON.parse(event.data); } catch (_) { return; } if (msg.type === "command" && msg.command) processPushedCommand(msg.command); };
      ws.onerror = () => blog("Push: WebSocket gặp lỗi.");
      ws.onclose = () => { if (_commandSocket === ws) _commandSocket = null; if (_socketHeartbeat) clearInterval(_socketHeartbeat); _socketHeartbeat = null; if (_socketReconnectTimer) clearTimeout(_socketReconnectTimer); _socketReconnectTimer = setTimeout(connectCommandSocket, 5000); blog("Push: WebSocket đóng; sẽ kết nối lại sau 5 giây."); };
    } catch (e) { blog("Push: lỗi tạo WebSocket:", e.message); _socketReconnectTimer = setTimeout(connectCommandSocket, 10000); }
  });
}
async function processPushedCommand(cmd) {
  if (!cmd || !cmd.id || !cmd.type || _processingCommands.has(cmd.id)) return;
  _processingCommands.add(cmd.id);
  try {
    const state = await chrome.storage.local.get({ completedCommandIds: [] });
    const completed = Array.isArray(state.completedCommandIds) ? state.completedCommandIds : [];
    if (completed.includes(cmd.id)) { await ackPushedCommand(cmd.id); return; }

    if (cmd.type === "status") {
      const cfg = await chrome.storage.local.get({
        tgEnabled: false, autoFillEnabled: false, autoOrderOnNotify: false,
        autoSubmitOrder: false, bizAiAutoContinue: true, workerUrl: "", pullSecret: ""
      });
      await reportRemoteStatus(cmd.chatId, cfg);
    } else if (cmd.type === "config") {
      const allowed = ["tgEnabled", "autoFillEnabled", "autoOrderOnNotify", "autoSubmitOrder", "bizAiAutoContinue"];
      const settings = {};
      for (const key of allowed) if (typeof cmd.settings?.[key] === "boolean") settings[key] = cmd.settings[key];
      if (Object.keys(settings).length) await chrome.storage.local.set(settings);
      const cfg = await chrome.storage.local.get({
        tgEnabled: false, autoFillEnabled: false, autoOrderOnNotify: false,
        autoSubmitOrder: false, workerUrl: "", pullSecret: ""
      });
      await reportRemoteStatus(cmd.chatId, cfg, "✅ Đã áp dụng cấu hình từ Telegram.");
      blog("Push: đã cập nhật cấu hình từ Telegram:", JSON.stringify(settings));
    } else if (cmd.type === "fill") {
      const cfg = await chrome.storage.local.get({ autoFillEnabled: false });
      if (!cfg.autoFillEnabled) {
        await reportRemoteStatus(cmd.chatId, null, "⛔ Chưa bật nhận lệnh lên đơn. Gửi /orders_on để bật.");
      } else {
        blog(`Push: nhận lệnh ${cmd.id} cho ${cmd.phone}.`);
        try {
          const result = await fillOrderByPhone(cmd.phone);
          const failed = result?.ok === false || result?.filled === false || !!result?.error;
          const message = failed
            ? "⚠️ Lệnh lên đơn chưa hoàn tất cho " + cmd.phone + ": " + String(result?.error || result?.summary || "Không điền được form.").slice(0, 500) + " Tab Vpage được giữ lại để kiểm tra."
            : result?.submitted
              ? "✅ Đã điền và gửi đơn cho SĐT " + cmd.phone + "."
              : result?.reviewRequired
                ? "📝 Đã điền form cho SĐT " + cmd.phone + " nhưng CHƯA lưu. Tab Vpage được giữ lại để kiểm tra."
                : "✅ Extension đã xử lý lệnh lên đơn cho SĐT " + cmd.phone + ". Hãy kiểm tra tab Vpage nếu cần.";
          await reportRemoteStatus(cmd.chatId, null, message);
        } catch (e) {
          blog(`Push: lên đơn lỗi cho ${cmd.phone}: ${e.message}`);
          await reportRemoteStatus(cmd.chatId, null, "❌ Lên đơn lỗi cho " + cmd.phone + ": " + e.message.slice(0, 500));
        }
      }
    } else {
      blog("Push: bỏ qua loại lệnh không hỗ trợ:", cmd.type);
    }

    await chrome.storage.local.set({ completedCommandIds: [...completed.filter(id => id !== cmd.id), cmd.id].slice(-500) });
    await ackPushedCommand(cmd.id);
    blog(`Push: đã ACK lệnh ${cmd.id}.`);
  } catch (e) { blog(`Push: xử lý lệnh ${cmd.id} lỗi:`, e.message); }
  finally { _processingCommands.delete(cmd.id); }
}

async function reportRemoteStatus(chatId, cfg = null, prefix = "") {
  if (!chatId) return;
  let text = prefix ? prefix + "\n" : "";
  if (cfg) {
    text += "📊 Trạng thái extension VPage\n" +
      "🔔 Thông báo Telegram: " + (cfg.tgEnabled ? "BẬT" : "TẮT") + "\n" +
      "📥 Nhận lệnh lên đơn từ Telegram: " + (cfg.autoFillEnabled ? "BẬT" : "TẮT") + "\n" +
      "⚙️ Tự lên đơn khi gửi thông báo: " + (cfg.autoOrderOnNotify ? "BẬT" : "TẮT") + "\n" +
      "💾 Tự động bấm Lưu/gửi đơn: " + (cfg.autoSubmitOrder ? "BẬT" : "TẮT") + "\n" +
      "🤖 Tự bấm Tiếp tục Business AI: " + (cfg.bizAiAutoContinue !== false ? "BẬT" : "TẮT");
  }
  if (!text.trim()) return;
  const current = await chrome.storage.local.get({ workerUrl: "", pullSecret: "" });
  if (!current.workerUrl || !current.pullSecret) return;
  const resp = await fetch(current.workerUrl.replace(/\/+$/, "") + "/report", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pull-secret": current.pullSecret },
    body: JSON.stringify({ chatId, text })
  });
  if (!resp.ok) throw new Error("Report HTTP " + resp.status);
}
async function ackPushedCommand(id) {
  const cfg = await chrome.storage.local.get({ workerUrl: "", pullSecret: "" });
  if (!cfg.workerUrl || !cfg.pullSecret) throw new Error("Thiếu Worker URL/Secret");
  const resp = await fetch(cfg.workerUrl.replace(/\/+$/, "") + "/ack", {
    method: "POST", headers: { "content-type": "application/json", "x-pull-secret": cfg.pullSecret },
    body: JSON.stringify({ id })
  });
  if (!resp.ok) throw new Error("ACK HTTP " + resp.status);
}
function disconnectCommandSocket() {
  if (_socketReconnectTimer) clearTimeout(_socketReconnectTimer);
  if (_socketHeartbeat) clearInterval(_socketHeartbeat);
  _socketHeartbeat = null;
  _socketReconnectTimer = null;
  if (_commandSocket) { _commandSocket.onclose = null; try { _commandSocket.close(); } catch (_) {} _commandSocket = null; }
}

// Khóa chống chạy chồng nhiều lượt quét nếu một lượt mất hơn chu kỳ alarm.
let _scanBusy = false;
async function runScanCycleSafe() {
  if (_scanBusy) {
    blog("Quét bỏ qua: lượt quét trước vẫn đang chạy.");
    return;
  }
  _scanBusy = true;
  try {
    await runScanCycle();
  } catch (e) {
    blog("runScanCycle lỗi:", e?.stack || e?.message || String(e));
  } finally {
    _scanBusy = false;
  }
}

// Đảm bảo alarm được tạo lại khi Chrome khởi động hoặc extension được cài/cập nhật.
async function ensureBackgroundAlarms() {
  const cfg = await chrome.storage.local.get({ scanIntervalMinutes: 3 });
  const minutes = Math.max(1, Math.min(1440, Number.parseInt(cfg.scanIntervalMinutes, 10) || 3));
  const scan = await chrome.alarms.get("ds-scan");
  if (!scan || scan.periodInMinutes !== minutes) {
    await chrome.alarms.clear("ds-scan");
    await chrome.alarms.create("ds-scan", { periodInMinutes: minutes });
    blog(`Đã cấu hình alarm ds-scan mỗi ${minutes} phút.`);
  } else {
    blog(`Alarm ds-scan đang hoạt động, chu kỳ ${scan.periodInMinutes} phút.`);
  }
  await chrome.alarms.clear("ds-pull"); // Ngừng polling KV cũ.
  connectCommandSocket();
}
ensureBackgroundAlarms().catch((e) => blog("Không khởi tạo được alarm:", e.message));
chrome.runtime.onStartup.addListener(() => {
  ensureBackgroundAlarms().catch((e) => blog("onStartup tạo alarm lỗi:", e.message));
  connectCommandSocket();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureBackgroundAlarms().catch((e) => blog("onInstalled tạo alarm lỗi:", e.message));
  connectCommandSocket();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.scanIntervalMinutes) ensureBackgroundAlarms().catch((e) => blog("Cập nhật chu kỳ quét lỗi:", e.message));
  if (changes.workerUrl || changes.pullSecret || changes.autoFillEnabled) { disconnectCommandSocket(); connectCommandSocket(); }
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "ds-scan") runScanCycleSafe();

});

// Handler test Telegram từ Options.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "TG_TEST") {
    tgSend(msg.token, msg.chatId, "✅ Test từ extension Bếp Cô Như. Kết nối Telegram OK!")
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
