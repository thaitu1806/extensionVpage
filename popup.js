const $ = (id) => document.getElementById(id);

function setStatus(msg, cls = "info") {
  const s = $("status");
  s.textContent = msg;
  s.className = "status " + cls;
}

// Kiểm tra đã có token chưa
chrome.storage.local.get({ apiToken: "" }, (cfg) => {
  if (!cfg.apiToken) {
    $("noToken").style.display = "block";
    $("fill").disabled = true;
  }
});

$("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("fill").addEventListener("click", async () => {
  $("fill").disabled = true;
  setStatus("Đang đọc tin nhắn chat...", "info");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("Không tìm thấy tab.");

    // Gửi lệnh tới background để xử lý toàn bộ luồng
    const res = await chrome.runtime.sendMessage({ type: "RUN_FILL", tabId: tab.id });

    if (!res) throw new Error("Không nhận được phản hồi.");
    if (res.ok) {
      setStatus("Đã điền xong!\n" + (res.summary || ""), "ok");
    } else {
      setStatus("Lỗi: " + (res.error || "không xác định"), "err");
    }
  } catch (e) {
    setStatus("Lỗi: " + e.message, "err");
  } finally {
    $("fill").disabled = false;
  }
});
