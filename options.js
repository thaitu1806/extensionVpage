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

const DEFAULTS = {
  apiToken: "",
  model: "deepseek-chat",
  msgCount: "3",
  catalog: DEFAULT_CATALOG,
  promoHCM: "",
  promoOther: "",
  hcmProvinces: "Bình Dương, Bà Rịa - Vũng Tàu, Đồng Nai, Long An, Tây Ninh, Bình Phước",
  tgEnabled: false,
  tgMsgCount: 3,
  scanMode: "unread",
  scanStrategy: "fixed",
  scanRecentCount: 5,
  scanDomRefreshEnabled: true,
  scanDomStableThreshold: 5,
  bizAiAutoContinue: false,
  scanIntervalMinutes: 3,
  tgToken: "",
  tgChatId: "",
  autoFillEnabled: false,
  autoOrderOnNotify: false,
  autoSubmitOrder: false,
  autoSendTrackingLink: false,
  orderTabMode: "default",
  autoOrderStatus: "Mới",
  workerUrl: "",
  pullSecret: "",
  geminiAddressFallbackEnabled: true,
  geminiConversationUrl: "https://gemini.google.com/app/b2af4712d4092d07"
};

const $ = (id) => document.getElementById(id);

function formatLastTelegramScanTime(value) {
  const timestamp = Number(value) || 0;
  if (!timestamp) return "Chưa có dữ liệu quét.";
  try {
    return new Date(timestamp).toLocaleString("vi-VN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    });
  } catch (_) {
    return new Date(timestamp).toLocaleString();
  }
}

function renderLastTelegramScanTime(value) {
  const el = $("lastTelegramScanAt");
  if (el) el.textContent = formatLastTelegramScanTime(value);
}

function load() {
  chrome.storage.local.get({ ...DEFAULTS, lastTelegramScanAt: 0 }, (cfg) => {
    renderLastTelegramScanTime(cfg.lastTelegramScanAt);
    $("apiToken").value = cfg.apiToken || "";
    $("model").value = cfg.model || "deepseek-chat";
    $("msgCount").value = cfg.msgCount || "3";
    $("catalog").value = cfg.catalog || "";
    $("promoHCM").value = cfg.promoHCM || "";
    $("promoOther").value = cfg.promoOther || "";
    $("hcmProvinces").value = cfg.hcmProvinces || "";
    $("tgEnabled").checked = !!cfg.tgEnabled;
    $("tgMsgCount").value = String(Math.max(1, Math.min(20, parseInt(cfg.tgMsgCount, 10) || 3)));
    $("scanMode").value = cfg.scanMode === "recent5" ? "recent5" : "unread";
    $("scanStrategy").value = cfg.scanStrategy === "incremental" ? "incremental" : "fixed";
    $("scanRecentCount").value = String(Math.max(1, Math.min(50, parseInt(cfg.scanRecentCount, 10) || 5)));
    $("scanDomRefreshEnabled").checked = cfg.scanDomRefreshEnabled !== false;
    $("scanDomStableThreshold").value = String(Math.max(1, Math.min(50, parseInt(cfg.scanDomStableThreshold, 10) || 5)));
    $("bizAiAutoContinue").checked = cfg.bizAiAutoContinue === true;
    $("scanIntervalMinutes").value = String(Math.max(1, Math.min(1440, parseInt(cfg.scanIntervalMinutes, 10) || 3)));
    $("tgToken").value = cfg.tgToken || "";
    $("tgChatId").value = cfg.tgChatId || "";
    $("autoFillEnabled").checked = !!cfg.autoFillEnabled;
    $("autoOrderOnNotify").checked = !!cfg.autoOrderOnNotify;
    $("autoSubmitOrder").checked = !!cfg.autoSubmitOrder;
    $("autoSendTrackingLink").checked = !!cfg.autoSendTrackingLink;
    $("orderTabMode").value = ["background", "switch"].includes(cfg.orderTabMode) ? cfg.orderTabMode : "default";
    $("autoOrderStatus").value = cfg.autoOrderStatus === "Đã xác nhận" ? "Đã xác nhận" : "Mới";
    $("workerUrl").value = cfg.workerUrl || "";
    $("pullSecret").value = cfg.pullSecret || "";
    $("geminiAddressFallbackEnabled").checked = cfg.geminiAddressFallbackEnabled !== false;
    $("geminiConversationUrl").value = cfg.geminiConversationUrl || DEFAULTS.geminiConversationUrl;
    $("geminiConversationLink").href = $("geminiConversationUrl").value;
  });
}

$("geminiConversationUrl")?.addEventListener("input", () => {
  const value = $("geminiConversationUrl").value.trim();
  $("geminiConversationLink").href = value || DEFAULTS.geminiConversationUrl;
});

function save() {
  const status = $("status");
  const count = parseInt($("msgCount").value, 10);
  const cfg = {
    apiToken: $("apiToken").value.trim(),
    model: $("model").value,
    msgCount: isNaN(count) || count < 1 ? "3" : String(Math.min(count, 10)),
    catalog: $("catalog").value.trim(),
    promoHCM: $("promoHCM").value.trim(),
    promoOther: $("promoOther").value.trim(),
    hcmProvinces: $("hcmProvinces").value.trim(),
    tgEnabled: $("tgEnabled").checked,
    tgMsgCount: Math.max(1, Math.min(20, parseInt($("tgMsgCount").value, 10) || 3)),
    scanMode: $("scanMode").value === "recent5" ? "recent5" : "unread",
    scanStrategy: $("scanStrategy").value === "incremental" ? "incremental" : "fixed",
    scanBaselineAt: $("scanStrategy").value === "incremental" ? Date.now() : 0,
    scanRecentCount: Math.max(1, Math.min(50, parseInt($("scanRecentCount").value, 10) || 5)),
    scanDomRefreshEnabled: $("scanDomRefreshEnabled").checked,
    scanDomStableThreshold: Math.max(1, Math.min(50, parseInt($("scanDomStableThreshold").value, 10) || 5)),
    bizAiAutoContinue: $("bizAiAutoContinue").checked,
    scanIntervalMinutes: Math.max(1, Math.min(1440, parseInt($("scanIntervalMinutes").value, 10) || 3)),
    tgToken: $("tgToken").value.trim(),
    tgChatId: $("tgChatId").value.trim(),
    autoFillEnabled: $("autoFillEnabled").checked,
    autoOrderOnNotify: $("autoOrderOnNotify").checked,
    autoSubmitOrder: $("autoSubmitOrder").checked,
    autoSendTrackingLink: $("autoSendTrackingLink").checked,
    orderTabMode: ["background", "switch"].includes($("orderTabMode").value) ? $("orderTabMode").value : "default",
    autoOrderStatus: $("autoOrderStatus").value === "Đã xác nhận" ? "Đã xác nhận" : "Mới",
    workerUrl: $("workerUrl").value.trim().replace(/\/+$/, ""),
    pullSecret: $("pullSecret").value.trim(),
    geminiAddressFallbackEnabled: $("geminiAddressFallbackEnabled").checked,
    geminiConversationUrl: $("geminiConversationUrl").value.trim() || DEFAULTS.geminiConversationUrl
  };

  let geminiUrl;
  try {
    geminiUrl = new URL(cfg.geminiConversationUrl);
    if (geminiUrl.protocol !== "https:" || geminiUrl.hostname !== "gemini.google.com" || !geminiUrl.pathname.startsWith("/app/")) {
      throw new Error("URL Gemini phải có dạng https://gemini.google.com/app/...");
    }
    cfg.geminiConversationUrl = geminiUrl.href;
  } catch (error) {
    status.textContent = error.message || "Link Gemini không hợp lệ.";
    status.className = "status err";
    return;
  }

  if (!cfg.apiToken) {
    status.textContent = "Vui lòng nhập API Token DeepSeek.";
    status.className = "status err";
    return;
  }

  chrome.storage.local.set(cfg, () => {
    status.textContent = "Đã lưu cấu hình thành công.";
    status.className = "status ok";
    setTimeout(() => (status.textContent = ""), 2500);
  });
}

function fmt(n) {
  return (Number(n) || 0).toLocaleString("vi-VN");
}

function renderAccount(res) {
  const box = $("account");
  box.style.display = "block";

  if (!res || !res.ok) {
    box.className = "account-box err";
    box.textContent = "Lỗi: " + ((res && res.error) || "không kiểm tra được.");
    return;
  }

  box.className = "account-box";
  const liveBadge = res.live
    ? '<span class="badge live">LIVE</span>'
    : '<span class="badge dead">KHÔNG HOẠT ĐỘNG</span>';

  let html = `Trạng thái token: ${liveBadge}`;
  html += `<br/>Khả dụng (is_available): <b>${res.isAvailable ? "Có" : "Không"}</b>`;

  if (res.balances && res.balances.length) {
    html += "<table>";
    html += "<tr><td><b>Tiền tệ</b></td><td><b>Tổng dư</b></td><td><b>Được tặng</b></td><td><b>Đã nạp</b></td></tr>";
    for (const b of res.balances) {
      html += `<tr>
        <td>${b.currency || ""}</td>
        <td>${b.total_balance ?? ""}</td>
        <td>${b.granted_balance ?? ""}</td>
        <td>${b.topped_up_balance ?? ""}</td>
      </tr>`;
    }
    html += "</table>";
  }

  // Usage đã lưu.
  chrome.storage.local.get(
    { lastUsage: null, usageTotal: { prompt: 0, completion: 0, total: 0, calls: 0 } },
    (st) => {
      const lu = st.lastUsage;
      const tt = st.usageTotal;
      let u = "<div class='divider'></div><b>Usage (tokens)</b>";
      if (lu) {
        u += `<br/>Lần gần nhất (${lu.model}): prompt ${fmt(lu.prompt_tokens)} + completion ${fmt(lu.completion_tokens)} = <b>${fmt(lu.total_tokens)}</b>`;
      } else {
        u += "<br/>Chưa có lần gọi nào.";
      }
      u += `<br/>Tổng cộng: ${fmt(tt.total)} tokens qua ${fmt(tt.calls)} lần gọi.`;
      box.innerHTML = html + u;
    }
  );
}

// Test độc lập tính năng chuẩn hóa địa chỉ bằng Responses API + web_search.
$("addressWebSearchTest").addEventListener("click", () => {
  const status = $("addressWebSearchStatus");
  const output = $("addressWebSearchOutput");
  const apiToken = $("apiToken").value.trim();
  const address = $("addressWebSearchInput").value.trim();
  output.value = "";

  if (!apiToken) {
    status.textContent = "Vui lòng nhập API Token DeepSeek ở phần cấu hình phía trên.";
    status.className = "status err";
    return;
  }
  if (!address) {
    status.textContent = "Vui lòng nhập địa chỉ cần chuẩn hóa.";
    status.className = "status err";
    return;
  }

  status.textContent = "Đang tra cứu Internet và chuẩn hóa địa chỉ...";
  status.className = "status";
  chrome.runtime.sendMessage(
    { type: "ADDRESS_WEB_SEARCH_TEST", apiToken, address },
    (res) => {
      if (chrome.runtime.lastError) {
        status.textContent = "Lỗi extension: " + chrome.runtime.lastError.message;
        status.className = "status err";
        return;
      }
      if (!res?.ok) {
        status.textContent = "Test thất bại: " + (res?.error || "Không nhận được kết quả.");
        status.className = "status err";
        if (res?.raw) output.value = res.raw;
        return;
      }
      output.value = JSON.stringify(res.data, null, 2);
      status.textContent = "Thành công. Đã nhận JSON từ DeepSeek Web Search.";
      status.className = "status ok";
    }
  );
});


 // Test tra cứu địa chỉ bằng Gemini đã có context.
 $("geminiAddressTest").addEventListener("click", () => {
   const status = $("geminiAddressStatus");
   const output = $("geminiAddressOutput");
   const address = $("geminiAddressInput").value.trim();
   output.value = "";
   if (!address) {
     status.textContent = "Vui lòng nhập địa chỉ cần chuẩn hóa.";
     status.className = "status err";
     return;
   }
   status.textContent = "Đang mở Gemini, gửi địa chỉ và chờ phản hồi...";
   status.className = "status";
   $("geminiAddressTest").disabled = true;
   chrome.runtime.sendMessage({ type: "GEMINI_ADDRESS_TEST", address }, (res) => {
     $("geminiAddressTest").disabled = false;
     if (chrome.runtime.lastError) {
       status.textContent = "Lỗi extension: " + chrome.runtime.lastError.message;
       status.className = "status err";
       return;
     }
     if (!res?.ok) {
       status.textContent = "Không lấy được kết quả: " + (res?.error || "Gemini chưa phản hồi.");
       status.className = "status err";
       if (res?.text) output.value = res.text;
       return;
     }
     output.value = res.text || "";
     status.textContent = res.warning || "Đã lấy được phản hồi Gemini. Hãy kiểm tra kết quả trước khi sử dụng.";
     status.className = "status ok";
   });
 });

$("check").addEventListener("click", () => {
  const box = $("account");
  box.style.display = "block";
  box.className = "account-box";
  box.textContent = "Đang kiểm tra...";
  const token = $("apiToken").value.trim();
  if (!token) {
    renderAccount({ ok: false, error: "Vui lòng nhập API Token trước." });
    return;
  }
  chrome.runtime.sendMessage({ type: "CHECK_ACCOUNT", apiToken: token }, (res) => {
    renderAccount(res);
  });
});

$("tgTest").addEventListener("click", () => {
  const st = $("tgStatus");
  st.textContent = "Đang gửi...";
  st.className = "status";
  chrome.runtime.sendMessage(
    { type: "TG_TEST", token: $("tgToken").value.trim(), chatId: $("tgChatId").value.trim() },
    (res) => {
      if (res && res.ok) { st.textContent = "Đã gửi tin test. Kiểm tra Telegram."; st.className = "status ok"; }
      else { st.textContent = "Lỗi: " + ((res && res.error) || "không gửi được"); st.className = "status err"; }
    }
  );
});

$("pullTest").addEventListener("click", () => {
  const st = $("pullStatus");
  st.textContent = "Đang kiểm tra...";
  st.className = "status";
  const base = $("workerUrl").value.trim().replace(/\/+$/, "");
  const secret = $("pullSecret").value.trim();
  if (!base) { st.textContent = "Nhập Worker URL trước."; st.className = "status err"; return; }

  fetch(base + "/health").then((r) => r.json()).then((h) => {
    if (!h || !h.ok || h.mode !== "queue-push") throw new Error("Worker chưa deploy bản Queue Push mới.");
    if (!secret) throw new Error("Chưa nhập Secret kết nối.");
    st.textContent = "Worker OK (Queue Push). WebSocket kết nối khi bật nhận lệnh và lưu cấu hình.";
    st.className = "status ok";
  }).catch((e) => { st.textContent = "Kiểm tra thất bại: " + e.message; st.className = "status err"; });
});

$("trackingLinkTestBtn").addEventListener("click", () => {
  const status = $("trackingLinkTestStatus");
  const url = $("trackingLinkTest").value.trim();
  status.textContent = "Đang kiểm tra...";
  status.className = "status";
  if (!url) {
    status.textContent = "Hãy dán link tracking hoặc nội dung mã đơn hàng.";
    status.className = "status err";
    return;
  }
  chrome.runtime.sendMessage({ type: "TEST_TRACKING_LINK", url }, (res) => {
    if (chrome.runtime.lastError) {
      status.textContent = "Lỗi extension: " + chrome.runtime.lastError.message;
      status.className = "status err";
      return;
    }
    status.textContent = res?.message || "Không nhận được kết quả kiểm tra.";
    status.className = res?.ok && res?.detected ? "status ok" : "status err";
  });
});

$("vpageAutoOrderTestBtn").addEventListener("click", async () => {
  const status = $("vpageAutoOrderTestStatus");
  const raw = $("vpageBoxTestUrl").value.trim();
  status.textContent = "Đang chạy FULL TEST: trích xuất, điền, lưu đơn và gửi link tracking...";
  status.className = "status";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "vpage.nhanh.vn" ||
        !(url.pathname === "/conversation" || url.pathname.startsWith("/app/conversation"))) {
      throw new Error("Hãy nhập URL hội thoại VPage hợp lệ ở ô phía trên.");
    }
    const tab = await chrome.tabs.create({ url: url.href, active: true });
    const tabId = tab.id;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Hết thời gian chờ VPage tải.")); }, 30000);
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await new Promise(r => setTimeout(r, 2500));
    const res = await chrome.runtime.sendMessage({ type: "TEST_VPAGE_AUTO_ORDER", tabId });
    if (!res?.ok) throw new Error(res?.error || "Test tự lên đơn thất bại.");
    status.textContent = res.summary || "Đã lưu đơn và gửi link tracking thành công. Tab test đã đóng.";
    status.className = "status ok";
  } catch (e) {
    status.textContent = "FULL TEST dừng/lỗi: " + e.message;
    status.className = "status err";
  }
});

$("vpageBoxTestBtn").addEventListener("click", async () => {
  const status = $("vpageBoxTestStatus");
  const raw = $("vpageBoxTestUrl").value.trim();
  status.textContent = "Đang mở đúng hội thoại và đọc dữ liệu...";
  status.className = "status";
  let tabId = null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "vpage.nhanh.vn" ||
        !(url.pathname === "/conversation" || url.pathname.startsWith("/app/conversation"))) {
      throw new Error("Chỉ chấp nhận URL hội thoại https://vpage.nhanh.vn/conversation?cid=... hoặc /app/conversation...");
    }
    const tab = await chrome.tabs.create({ url: url.href, active: true });
    tabId = tab.id;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Hết thời gian chờ VPage tải.")); }, 30000);
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await new Promise(r => setTimeout(r, 2500));
    const res = await chrome.runtime.sendMessage({ type: "TEST_VPAGE_CONVERSATION", tabId });
    if (!res?.ok) throw new Error(res?.error || "Test thất bại.");
    status.textContent = res.summary + " Mở Console của Service Worker để xem [BOX TEST]. Tab hội thoại được giữ mở.";
    status.className = "status ok";
  } catch (e) {
    status.textContent = "Lỗi: " + e.message;
    status.className = "status err";
  }
});

$("manualOrderTest").addEventListener("click", () => {
  const status = $("manualOrderStatus");
  const orderText = $("manualOrderText").value.trim();
  status.textContent = "";
  status.className = "status";
  if (!orderText) {
    status.textContent = "Hãy dán nội dung đơn hàng trước.";
    status.className = "status err";
    return;
  }
  status.textContent = "Đang phân tích và điền thử... Hãy chờ, không đóng trang.";
  chrome.runtime.sendMessage({ type: "RUN_TEST_ORDER", orderText }, (res) => {
    if (chrome.runtime.lastError) {
      status.textContent = "Lỗi kết nối extension: " + chrome.runtime.lastError.message;
      status.className = "status err";
      return;
    }
    if (res && res.ok) {
      status.textContent = "Đã chạy test. " + (res.summary || "") + " Form không được tự lưu; hãy kiểm tra tab Vpage.";
      status.className = "status ok";
    } else {
      status.textContent = "Test thất bại: " + ((res && res.error) || "Không rõ lỗi");
      status.className = "status err";
    }
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.lastTelegramScanAt) {
    renderLastTelegramScanTime(changes.lastTelegramScanAt.newValue);
  }
});

document.addEventListener("DOMContentLoaded", load);
$("save").addEventListener("click", save);



function startVpageV2Scanner() {
  if (window.__vpageV2Scanner?.active) return { ok: true, alreadyRunning: true };
  const state = { startedAt: new Date().toISOString(), pageUrl: location.href, title: document.title, active: true, mutations: [] };
  const clean = (v, n=500) => String(v || "").replace(/\s+/g, " ").trim().slice(0,n);
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const describe = el => {
    if (!el || el.nodeType !== 1) return null;
    const attrs = {};
    for (const a of Array.from(el.attributes || [])) {
      if (/^(value|style|srcdoc)$/i.test(a.name) || /token|cookie|authorization|secret|password/i.test(a.name)) continue;
      attrs[a.name] = clean(a.value, 220);
    }
    return { tag: el.tagName.toLowerCase(), id: el.id || "", className: typeof el.className === "string" ? clean(el.className,250) : "", attributes: attrs, text: clean(el.innerText || el.textContent,650) };
  };
  const collect = () => {
    const all = Array.from(document.querySelectorAll("body *")).filter(visible);
    const customers = [];
    document.querySelectorAll("b[class]").forEach(el => {
      const m = String(el.className).match(/(?:^|\s)customer-(\d+)(?:\s|$)/);
      if (m) customers.push({ conversationId: m[1], name: clean(el.innerText,150), element: describe(el) });
    });
    const unique = [...new Map(customers.map(x => [x.conversationId,x])).values()];
    const conv = all.filter(el => el.matches("b[class*='customer-'],[class*='conversation'],[class*='chat-item'],[class*='inbox-item'],[data-conversation-id]")).slice(0,100);
    const msgs = all.filter(el => el.matches("[class*='message'],[class*='msg'],[data-message-id]")).slice(0,150);
    const contacts = all.filter(el => el.matches("input,textarea,[class*='customer-info'],[class*='contact-info'],[class*='profile']")).slice(0,60).map(el => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? {tag:el.tagName.toLowerCase(),id:el.id||"",name:el.getAttribute("name")||"",placeholder:el.getAttribute("placeholder")||"",type:el.getAttribute("type")||""} : describe(el));
    return { capturedAt:new Date().toISOString(), url:location.href, title:document.title, counts:{visibleElements:all.length,conversationCandidates:conv.length,messageCandidates:msgs.length,customerIds:unique.length}, customerIds:unique, conversationCandidates:conv.map(describe), messageCandidates:msgs.map(describe), contactCandidates:contacts };
  };
  state.initial = collect();
  state.observer = new MutationObserver(() => {
    if (!state.active || state.mutations.length >= 35) return;
    const snap = collect();
    const sig = JSON.stringify(snap.counts)+"|"+snap.customerIds.map(x=>x.conversationId).join(",");
    if (sig !== state.lastSig || Date.now()-(state.lastAt||0)>1500) {
      state.mutations.push(snap); state.lastSig=sig; state.lastAt=Date.now();
    }
  });
  state.observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["class","aria-label","data-conversation-id","data-message-id"]});
  window.__vpageV2Scanner=state;
  return {ok:true,startedAt:state.startedAt,counts:state.initial.counts};
}

function stopVpageV2Scanner() {
  const s=window.__vpageV2Scanner;
  if (!s) return {ok:false,error:"Không tìm thấy phiên quét. Hãy bắt đầu lại trên tab VPage."};
  s.active=false; s.observer?.disconnect();
  const resources=performance.getEntriesByType("resource").filter(e=>/nhanh\.vn/i.test(e.name)).map(e=>{
    let url=e.name; try {const u=new URL(e.name);url=u.origin+u.pathname;}catch(_){}
    return {url,initiatorType:e.initiatorType,durationMs:Math.round(e.duration),transferSize:e.transferSize||0};
  });
  const unique=[...new Map(resources.map(x=>[x.url+"|"+x.initiatorType,x])).values()];
  const report={scanner:"VPage V2 DOM Scanner",version:1,startedAt:s.startedAt,stoppedAt:new Date().toISOString(),pageUrl:s.pageUrl,pageTitle:s.title,note:"Chỉ thu DOM snapshots và URL Resource Timing. Không thu HTTP method, request payload, response body, cookie hoặc authorization.",initial:s.initial,mutationSnapshots:s.mutations,networkResources:unique};
  delete window.__vpageV2Scanner;
  return {ok:true,report};
}

async function getVpageScanTab() {
  // Tìm tab VPage đang mở, không phụ thuộc tab Cấu hình đang được focus.
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const vpageTabs = tabs.filter(tab => {
    try { return new URL(tab.url || "").hostname.toLowerCase() === "vpage.nhanh.vn"; }
    catch (_) { return false; }
  });
  if (!vpageTabs.length) {
    throw new Error("Chưa tìm thấy tab VPage. Hãy mở https://vpage.nhanh.vn rồi quay lại Cấu hình.");
  }
  // Ưu tiên tab VPage đang active; nếu không có thì lấy tab VPage đầu tiên.
  return vpageTabs.find(tab => tab.active) || vpageTabs[0];
}
async function startVpageScanFromOptions() {
  const st=$("v2ScanStatus"); st.textContent="Đang khởi tạo scanner..."; st.className="status";
  try {
    const tab=await getVpageScanTab();
    const out=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:startVpageV2Scanner});
    const r=out?.[0]?.result; if(!r?.ok) throw new Error("Không khởi tạo được scanner.");
    $("v2ScanStart").disabled=true; $("v2ScanStop").disabled=false;
    st.textContent=r.alreadyRunning?"Scanner đang chạy.":"Đã bắt đầu quét. Hãy mở và chuyển qua một vài hội thoại VPage.";
    st.className="status ok";
  } catch(e) {st.textContent="Lỗi: "+e.message;st.className="status err";}
}
async function stopVpageScanFromOptions() {
  const st=$("v2ScanStatus"); st.textContent="Đang tổng hợp JSON...";st.className="status";
  try {
    const tab=await getVpageScanTab();
    const out=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:stopVpageV2Scanner});
    const r=out?.[0]?.result;if(!r?.ok)throw new Error(r?.error||"Không lấy được dữ liệu.");
    const blob=new Blob([JSON.stringify(r.report,null,2)],{type:"application/json;charset=utf-8"});
    const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;
    a.download="vpage-v2-scan-"+new Date().toISOString().replace(/[:.]/g,"-")+".json";
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $("v2ScanStart").disabled=false;$("v2ScanStop").disabled=true;
    st.textContent="Đã xuất JSON: "+(1+r.report.mutationSnapshots.length)+" snapshot DOM, "+r.report.networkResources.length+" URL tài nguyên.";
    st.className="status ok";
  } catch(e) {st.textContent="Lỗi: "+e.message;st.className="status err";}
}
$("v2ScanStart").addEventListener("click",startVpageScanFromOptions);
$("v2ScanStop").addEventListener("click",stopVpageScanFromOptions);
