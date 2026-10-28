/** Telegram -> Queue -> Durable Object -> WebSocket -> Chrome extension. */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
 async fetch(request, env) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/";
  try {
   if (path === "/health") return json({ ok: true, mode: "queue-push", ts: Date.now() });
   if (path === "/telegram" && request.method === "POST") return handleTelegram(request, env);
   if (path === "/ws") return env.COMMANDS.get(env.COMMANDS.idFromName("global")).fetch(request);
   if (path === "/ack" && request.method === "POST") {
    if (!checkSecret(request, env)) return json({ ok: false, error: "bad secret" }, 401);
    const body = await request.json().catch(() => ({}));
    if (!body.id) return json({ ok: false, error: "missing id" }, 400);
    return env.COMMANDS.get(env.COMMANDS.idFromName("global")).fetch("https://command-hub.internal/ack", {
     method: "POST", headers: { "content-type": "application/json", "x-pull-secret": env.PULL_SECRET },
     body: JSON.stringify({ id: String(body.id) })
    });
   }
   if (path === "/report" && request.method === "POST") {
    if (!checkSecret(request, env)) return json({ ok: false, error: "bad secret" }, 401);
    const body = await request.json().catch(() => ({}));
    if (!body.chatId || !body.text) return json({ ok: false, error: "missing chatId/text" }, 400);
    await sendTelegram(env, body.chatId, String(body.text).slice(0, 3500));
    return json({ ok: true });
   }
   if (path === "/pull") return json({ ok: false, error: "polling_disabled", message: "Cập nhật extension sang bản Queue Push." }, 410);
   return json({ ok: false, error: "not found" }, 404);
  } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
 },
 async queue(batch, env) {
  const stub = env.COMMANDS.get(env.COMMANDS.idFromName("global"));
  for (const message of batch.messages) {
   try {
    const response = await stub.fetch("https://command-hub.internal/enqueue", {
     method: "POST", headers: { "content-type": "application/json", "x-internal-secret": env.PULL_SECRET || "" },
     body: JSON.stringify(message.body)
    });
    if (!response.ok) throw new Error("Durable Object HTTP " + response.status);
    message.ack();
   } catch (e) { console.error("Queue delivery failed:", e); message.retry(); }
  }
 }
};

function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS }); }

async function handleTelegram(request, env) {
 if (env.TG_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.TG_SECRET)
  return json({ ok: false, error: "bad secret" }, 401);

 const update = await request.json().catch(() => null);
 if (!update) return json({ ok: true });
 const cq = update.callback_query;
 if (cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (!chatIdAllowed(env, chatId)) { await answerCallback(env, cq.id, "Không có quyền."); return json({ ok: true }); }
  const match = String(cq.data || "").match(/^fill:(\d{6,15})$/);
  if (!match) { await answerCallback(env, cq.id, "Lệnh không hợp lệ."); return json({ ok: true }); }
  const command = { id: Date.now() + "_" + crypto.randomUUID().slice(0, 8), type: "fill", phone: match[1], chatId, ts: Date.now() };
  await env.ORDERS_QUEUE.send(command);
  await answerCallback(env, cq.id, "Đã nhận lệnh lên đơn cho " + command.phone + ". Đang chuyển đến extension...");
  return json({ ok: true, queued: true, id: command.id });
 }

 const message = update.message || update.edited_message;
 const chatId = message && message.chat && message.chat.id;
 const text = String(message && message.text || "").trim();
 if (!text.startsWith("/")) return json({ ok: true });
 if (!chatIdAllowed(env, chatId)) { await sendTelegram(env, chatId, "⛔ Chat này chưa được cấp quyền điều khiển."); return json({ ok: true }); }

 const commandName = text.split(/\s+/)[0].split("@")[0].toLowerCase();
 if (!env.ALLOWED_CHAT_IDS && commandName !== "/help" && commandName !== "/start") {
  await sendTelegram(env, chatId, "🔐 Chưa cấu hình ALLOWED_CHAT_IDS trên Worker. Hãy thêm Chat ID được phép trước khi dùng lệnh điều khiển.");
  return json({ ok: true });
 }
 const actions = {
  "/auto_on": ["set", { autoOrderOnNotify: true }, "✅ Đã yêu cầu bật tự động lên đơn khi gửi thông báo."],
  "/auto_off": ["set", { autoOrderOnNotify: false }, "🛑 Đã yêu cầu tắt tự động lên đơn khi gửi thông báo. Thông báo Telegram vẫn hoạt động."],
  "/orders_on": ["set", { autoFillEnabled: true }, "✅ Đã yêu cầu bật nhận lệnh lên đơn từ Telegram."],
  "/orders_off": ["set", { autoFillEnabled: false }, "🛑 Đã yêu cầu tắt nhận lệnh lên đơn từ Telegram."],
  "/save_on": ["set", { autoSubmitOrder: true }, "⚠️ Đã yêu cầu bật tự động bấm Lưu/gửi đơn."],
  "/save_off": ["set", { autoSubmitOrder: false }, "✅ Đã yêu cầu tắt tự động bấm Lưu/gửi đơn; đơn sẽ cần kiểm tra/lưu thủ công."],
  "/notify_on": ["set", { tgEnabled: true }, "✅ Đã yêu cầu bật thông báo Telegram."],
  "/notify_off": ["set", { tgEnabled: false }, "🛑 Đã yêu cầu tắt thông báo Telegram."],
  "/status": ["status", {}, ""]
 };
 if (commandName === "/help" || commandName === "/start") {
  await sendTelegram(env, chatId,
   "📱 Điều khiển extension VPage\n\n" +
   "/status — xem cấu hình hiện tại\n" +
   "/auto_on | /auto_off — bật/tắt tự lên đơn khi gửi thông báo\n" +
   "/orders_on | /orders_off — bật/tắt nhận nút Lên đơn từ Telegram\n" +
   "/save_on | /save_off — bật/tắt tự động lưu/gửi đơn\n" +
   "/notify_on | /notify_off — bật/tắt thông báo Telegram\n\n" +
   "Lưu ý: Chrome phải mở, extension hoạt động và đã kết nối Worker. /save_on có thể tạo đơn thật.");
  return json({ ok: true });
 }
 const action = actions[commandName];
 if (!action) { await sendTelegram(env, chatId, "Không hiểu lệnh này. Gửi /help để xem các lệnh."); return json({ ok: true }); }
 const cmd = { id: Date.now() + "_" + crypto.randomUUID().slice(0, 8), type: action[0] === "status" ? "status" : "config", settings: action[1], chatId, ts: Date.now() };
 await env.ORDERS_QUEUE.send(cmd);
 if (action[2]) await sendTelegram(env, chatId, action[2] + "\nĐang chuyển lệnh đến extension...");
 return json({ ok: true, queued: true, id: cmd.id });
}

function chatIdAllowed(env, chatId) {
 if (chatId == null) return false;
 if (!env.ALLOWED_CHAT_IDS) return true;
 return String(env.ALLOWED_CHAT_IDS).split(",").map(s => s.trim()).filter(Boolean).includes(String(chatId));
}
async function sendTelegram(env, chatId, text) {
 if (!env.BOT_TOKEN || chatId == null) return;
 const response = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
  method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, text })
 });
 if (!response.ok) throw new Error("Telegram sendMessage HTTP " + response.status);
}
async function answerCallback(env, id, text) {
 if (!env.BOT_TOKEN) return;
 await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/answerCallbackQuery", {
  method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ callback_query_id: id, text, show_alert: false })
 }).catch(() => {});
}
function checkSecret(request, env) { return !!env.PULL_SECRET && request.headers.get("x-pull-secret") === env.PULL_SECRET; }

export class CommandHub {
 constructor(state, env) { this.state = state; this.env = env; }
 webSocketMessage(ws, message) {
  try { const data = JSON.parse(typeof message === "string" ? message : ""); if (data.type === "ping") ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); } catch (_) {}
 }
 async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/ws") {
   if (!this.env.PULL_SECRET || url.searchParams.get("secret") !== this.env.PULL_SECRET) return new Response("Unauthorized", { status: 401 });
   if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
   const pair = new WebSocketPair(), client = pair[0], server = pair[1];
   this.state.acceptWebSocket(server);
   const pending = await this.state.storage.list({ prefix: "cmd:" });
   for (const command of pending.values()) try { server.send(JSON.stringify({ type: "command", command })); } catch (_) {}
   return new Response(null, { status: 101, webSocket: client });
  }
  if (url.pathname === "/enqueue" && request.method === "POST") {
   if (!this.env.PULL_SECRET || request.headers.get("x-internal-secret") !== this.env.PULL_SECRET) return json({ ok: false, error: "bad secret" }, 401);
   const cmd = await request.json().catch(() => null);
   if (!cmd || !cmd.id || !cmd.type || (cmd.type === "fill" && !cmd.phone)) return json({ ok: false, error: "invalid command" }, 400);
   await this.state.storage.put("cmd:" + cmd.id, cmd);
   for (const ws of this.state.getWebSockets()) try { ws.send(JSON.stringify({ type: "command", command: cmd })); } catch (_) {}
   return json({ ok: true });
  }
  if (url.pathname === "/ack" && request.method === "POST") {
   if (!this.env.PULL_SECRET || request.headers.get("x-pull-secret") !== this.env.PULL_SECRET) return json({ ok: false, error: "bad secret" }, 401);
   const body = await request.json().catch(() => ({}));
   if (!body.id) return json({ ok: false, error: "missing id" }, 400);
   await this.state.storage.delete("cmd:" + String(body.id));
   return json({ ok: true });
  }
  return json({ ok: false, error: "not found" }, 404);
 }
}
