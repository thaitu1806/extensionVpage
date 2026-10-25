/**
 * Cloudflare Worker: cầu nối Telegram <-> Extension để lên đơn tự động.
 *
 * LUỒNG:
 *   1) Extension gửi thông báo đơn kèm nút callback "Lên đơn tự động".
 *   2) Người dùng bấm nút trên ĐIỆN THOẠI -> Telegram gọi webhook POST /telegram.
 *   3) Worker ghi lệnh {phone} vào KV (hàng đợi ORDERS).
 *   4) Extension POLL GET /pull mỗi ~30s -> nhận lệnh -> lên đơn -> POST /ack.
 *
 * BIẾN MÔI TRƯỜNG (Settings -> Variables & Secrets):
 *   - BOT_TOKEN        : token bot Telegram (secret).
 *   - TG_SECRET        : chuỗi bí mật đặt khi set webhook (header X-Telegram-Bot-Api-Secret-Token).
 *   - PULL_SECRET      : chuỗi bí mật extension gửi kèm khi /pull, /ack (header x-pull-secret).
 *   - ALLOWED_CHAT_IDS : (tùy chọn) danh sách chat_id được phép, ngăn cách dấu phẩy.
 *
 * KV NAMESPACE (Settings -> Bindings):
 *   - ORDERS : lưu hàng đợi lệnh lên đơn.
 *
 * ENDPOINTS:
 *   POST /telegram  : webhook Telegram (callback_query / message).
 *   GET  /pull      : extension lấy các lệnh đang chờ. Trả { commands: [{id, phone, ts}] }.
 *   POST /ack       : extension báo đã xử lý xong 1 lệnh. Body { id }.
 *   GET  /health    : kiểm tra sống.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health") {
        return json({ ok: true, ts: Date.now() });
      }
      if (path === "/telegram" && request.method === "POST") {
        return handleTelegram(request, env);
      }
      if (path === "/pull" && request.method === "GET") {
        return handlePull(request, env);
      }
      if (path === "/ack" && request.method === "POST") {
        return handleAck(request, env);
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  }
};

function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...(extraHeaders || {}) }
  });
}

/* ============== WEBHOOK TELEGRAM ============== */

async function handleTelegram(request, env) {
  // Xác thực: Telegram gửi kèm header secret đã đặt khi setWebhook.
  if (env.TG_SECRET) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== env.TG_SECRET) return json({ ok: false, error: "bad secret" }, 401);
  }

  const update = await request.json().catch(() => null);
  if (!update) return json({ ok: true }); // bỏ qua update rác

  // Chỉ xử lý callback_query (bấm nút inline).
  const cq = update.callback_query;
  if (!cq) return json({ ok: true });

  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (!chatIdAllowed(env, chatId)) {
    await answerCallback(env, cq.id, "Không có quyền.");
    return json({ ok: true });
  }

  // data dạng "fill:<phone>".
  const data = String(cq.data || "");
  const m = data.match(/^fill:(\d{6,15})$/);
  if (!m) {
    await answerCallback(env, cq.id, "Lệnh không hợp lệ.");
    return json({ ok: true });
  }
  const phone = m[1];

  // Ghi lệnh vào KV (hàng đợi). Key có tiền tố "cmd:" + timestamp để /pull quét.
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cmd = { id, phone, chatId, ts: Date.now(), status: "pending" };
  // TTL 1 giờ: nếu extension không xử lý thì tự hết hạn.
  await env.ORDERS.put(`cmd:${id}`, JSON.stringify(cmd), { expirationTtl: 3600 });

  await answerCallback(env, cq.id, `Đã nhận lệnh lên đơn cho ${phone}. Đang xử lý...`);
  return json({ ok: true });
}

function chatIdAllowed(env, chatId) {
  if (!env.ALLOWED_CHAT_IDS) return true; // không giới hạn
  const list = String(env.ALLOWED_CHAT_IDS).split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(String(chatId));
}

async function answerCallback(env, callbackQueryId, text) {
  if (!env.BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
  }).catch(() => {});
}

/* ============== API CHO EXTENSION ============== */

function checkPullSecret(request, env) {
  if (!env.PULL_SECRET) return true;
  return request.headers.get("x-pull-secret") === env.PULL_SECRET;
}

// Extension lấy các lệnh đang chờ.
async function handlePull(request, env) {
  if (!checkPullSecret(request, env)) return json({ ok: false, error: "bad secret" }, 401);

  const list = await env.ORDERS.list({ prefix: "cmd:" });
  const commands = [];
  for (const k of list.keys) {
    const raw = await env.ORDERS.get(k.name);
    if (!raw) continue;
    try {
      const cmd = JSON.parse(raw);
      if (cmd.status === "pending") commands.push({ id: cmd.id, phone: cmd.phone, ts: cmd.ts });
    } catch (_) {}
  }
  // Sắp xếp theo thời gian tăng dần (xử lý cũ trước).
  commands.sort((a, b) => a.ts - b.ts);
  return json({ ok: true, commands }, 200, { "cache-control": "no-store" });
}

// Extension báo đã xử lý xong 1 lệnh -> xóa khỏi hàng đợi.
async function handleAck(request, env) {
  if (!checkPullSecret(request, env)) return json({ ok: false, error: "bad secret" }, 401);

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return json({ ok: false, error: "missing id" }, 400);

  await env.ORDERS.delete(`cmd:${id}`);
  return json({ ok: true });
}
