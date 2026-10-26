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
  scanIntervalMinutes: 3,
  tgToken: "",
  tgChatId: "",
  autoFillEnabled: false,
  autoOrderOnNotify: false,
  autoSubmitOrder: false,
  autoOrderStatus: "Mới",
  workerUrl: "",
  pullSecret: ""
};

const $ = (id) => document.getElementById(id);

function load() {
  chrome.storage.local.get(DEFAULTS, (cfg) => {
    $("apiToken").value = cfg.apiToken || "";
    $("model").value = cfg.model || "deepseek-chat";
    $("msgCount").value = cfg.msgCount || "3";
    $("catalog").value = cfg.catalog || "";
    $("promoHCM").value = cfg.promoHCM || "";
    $("promoOther").value = cfg.promoOther || "";
    $("hcmProvinces").value = cfg.hcmProvinces || "";
    $("tgEnabled").checked = !!cfg.tgEnabled;
    $("scanIntervalMinutes").value = String(Math.max(1, Math.min(1440, parseInt(cfg.scanIntervalMinutes, 10) || 3)));
    $("tgToken").value = cfg.tgToken || "";
    $("tgChatId").value = cfg.tgChatId || "";
    $("autoFillEnabled").checked = !!cfg.autoFillEnabled;
    $("autoOrderOnNotify").checked = !!cfg.autoOrderOnNotify;
    $("autoSubmitOrder").checked = !!cfg.autoSubmitOrder;
    $("autoOrderStatus").value = cfg.autoOrderStatus === "Đã xác nhận" ? "Đã xác nhận" : "Mới";
    $("workerUrl").value = cfg.workerUrl || "";
    $("pullSecret").value = cfg.pullSecret || "";
  });
}

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
    scanIntervalMinutes: Math.max(1, Math.min(1440, parseInt($("scanIntervalMinutes").value, 10) || 3)),
    tgToken: $("tgToken").value.trim(),
    tgChatId: $("tgChatId").value.trim(),
    autoFillEnabled: $("autoFillEnabled").checked,
    autoOrderOnNotify: $("autoOrderOnNotify").checked,
    autoSubmitOrder: $("autoSubmitOrder").checked,
    autoOrderStatus: $("autoOrderStatus").value === "Đã xác nhận" ? "Đã xác nhận" : "Mới",
    workerUrl: $("workerUrl").value.trim().replace(/\/+$/, ""),
    pullSecret: $("pullSecret").value.trim()
  };

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

document.addEventListener("DOMContentLoaded", load);
$("save").addEventListener("click", save);
