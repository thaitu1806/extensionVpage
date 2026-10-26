/** Telegram -> Queue -> Durable Object -> WebSocket -> Chrome extension. */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
export default {
 async fetch(request,env){
  const url=new URL(request.url),path=url.pathname.replace(/\/+$/,"")||"/";
  try{
   if(path==="/health")return json({ok:true,mode:"queue-push",ts:Date.now()});
   if(path==="/telegram"&&request.method==="POST")return handleTelegram(request,env);
   if(path==="/ws")return env.COMMANDS.get(env.COMMANDS.idFromName("global")).fetch(request);
   if(path==="/ack"&&request.method==="POST"){
    if(!checkSecret(request,env))return json({ok:false,error:"bad secret"},401);
    const body=await request.json().catch(()=>({}));if(!body.id)return json({ok:false,error:"missing id"},400);
    return env.COMMANDS.get(env.COMMANDS.idFromName("global")).fetch("https://command-hub.internal/ack",{method:"POST",headers:{"content-type":"application/json","x-pull-secret":env.PULL_SECRET},body:JSON.stringify({id:String(body.id)})});
   }
   if(path==="/pull")return json({ok:false,error:"polling_disabled",message:"Cập nhật extension sang bản Queue Push."},410);
   return json({ok:false,error:"not found"},404);
  }catch(e){return json({ok:false,error:String(e&&e.message||e)},500);}
 },
 async queue(batch,env){
  const stub=env.COMMANDS.get(env.COMMANDS.idFromName("global"));
  for(const message of batch.messages){
   try{
    const response=await stub.fetch("https://command-hub.internal/enqueue",{method:"POST",headers:{"content-type":"application/json","x-internal-secret":env.PULL_SECRET||""},body:JSON.stringify(message.body)});
    if(!response.ok)throw new Error("Durable Object HTTP "+response.status);message.ack();
   }catch(e){console.error("Queue delivery failed:",e);message.retry();}
  }
 }
};
function json(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:JSON_HEADERS});}
async function handleTelegram(request,env){
 if(env.TG_SECRET&&request.headers.get("x-telegram-bot-api-secret-token")!==env.TG_SECRET)return json({ok:false,error:"bad secret"},401);
 const update=await request.json().catch(()=>null),cq=update&&update.callback_query;if(!cq)return json({ok:true});
 const chatId=cq.message&&cq.message.chat&&cq.message.chat.id;
 if(!chatIdAllowed(env,chatId)){await answerCallback(env,cq.id,"Không có quyền.");return json({ok:true});}
 const match=String(cq.data||"").match(/^fill:(\d{6,15})$/);
 if(!match){await answerCallback(env,cq.id,"Lệnh không hợp lệ.");return json({ok:true});}
 const now=Date.now(),command={id:now+"_"+crypto.randomUUID().slice(0,8),phone:match[1],chatId,ts:now};
 await env.ORDERS_QUEUE.send(command);await answerCallback(env,cq.id,"Đã nhận lệnh lên đơn cho "+command.phone+". Đang chuyển đến extension...");
 return json({ok:true,queued:true,id:command.id});
}
function chatIdAllowed(env,chatId){if(!env.ALLOWED_CHAT_IDS)return true;return String(env.ALLOWED_CHAT_IDS).split(",").map(s=>s.trim()).filter(Boolean).includes(String(chatId));}
async function answerCallback(env,id,text){if(!env.BOT_TOKEN)return;await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/answerCallbackQuery",{method:"POST",headers:JSON_HEADERS,body:JSON.stringify({callback_query_id:id,text,show_alert:false})}).catch(()=>{});}
function checkSecret(request,env){return !!env.PULL_SECRET&&request.headers.get("x-pull-secret")===env.PULL_SECRET;}

export class CommandHub{
 constructor(state,env){this.state=state;this.env=env;}
 webSocketMessage(ws,message){
  try{const data=JSON.parse(typeof message==="string"?message:"");if(data.type==="ping")ws.send(JSON.stringify({type:"pong",ts:Date.now()}));}catch(_){}
 }
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==="/ws"){
   if(!this.env.PULL_SECRET||url.searchParams.get("secret")!==this.env.PULL_SECRET)return new Response("Unauthorized",{status:401});
   if(request.headers.get("Upgrade")!=="websocket")return new Response("Expected WebSocket",{status:426});
   const pair=new WebSocketPair(),client=pair[0],server=pair[1];this.state.acceptWebSocket(server);
   const pending=await this.state.storage.list({prefix:"cmd:"});for(const command of pending.values())try{server.send(JSON.stringify({type:"command",command}));}catch(_){}
   return new Response(null,{status:101,webSocket:client});
  }
  if(url.pathname==="/enqueue"&&request.method==="POST"){
   if(!this.env.PULL_SECRET||request.headers.get("x-internal-secret")!==this.env.PULL_SECRET)return json({ok:false,error:"bad secret"},401);
   const cmd=await request.json().catch(()=>null);if(!cmd||!cmd.id||!cmd.phone)return json({ok:false,error:"invalid command"},400);
   await this.state.storage.put("cmd:"+cmd.id,cmd);for(const ws of this.state.getWebSockets())try{ws.send(JSON.stringify({type:"command",command:cmd}));}catch(_){}
   return json({ok:true});
  }
  if(url.pathname==="/ack"&&request.method==="POST"){
   if(!this.env.PULL_SECRET||request.headers.get("x-pull-secret")!==this.env.PULL_SECRET)return json({ok:false,error:"bad secret"},401);
   const body=await request.json().catch(()=>({}));if(!body.id)return json({ok:false,error:"missing id"},400);
   await this.state.storage.delete("cmd:"+String(body.id));return json({ok:true});
  }
  return json({ok:false,error:"not found"},404);
 }
}
