// EasyDrop 信标 + 自建 PeerJS 兼容信令总线
// 1) 发现信标：按 URL 路径主题分房，房内消息广播给其他连接（原逻辑不变）
// 2) PeerJS 兼容信令：路径 /easydrop-peerjs* → 单一总线房（easydrop-peerjs-bus）。
//    背景：第三方 0.peerjs.com 免费云端的 offer 中继在国内网络下经常被阻断，
//    表现为拨号 20 秒超时且连不存在的 ID 都不报 peer-unavailable（静默挂死）。
//    自建通道与 presence 发现总线同一 Cloudflare 基础设施，可达性一致。
//    协议契约（peerjs 客户端 1.5.2）：
//    - WS 连入 ?id=&token=&key= → 服务器回 {type:"OPEN"}；同 ID 已占用回
//      {type:"ID-TAKEN"}（客户端自动换实例后缀重试）
//    - 客户端 → {type:"OFFER"/"ANSWER"/"CANDIDATE", payload, dst}；
//      服务器注入 src 后精确投递给 dst 的注册连接
//    - dst 未注册/失活 → 回 {type:"EXPIRE", src:<dst>}，客户端立即得到
//      peer-unavailable（拨号端随即换候选，不再静默挂死）
//    - 连接断开 → 广播 {type:"LEAVE", src:<id>}，对端清理该 peer 的会话
//    - 客户端每 5 秒 HEARTBEAT；存活窗口放宽到 120 秒（容忍后台标签页节流）
// 走 443/WSS，无混合内容问题；休眠式 API，空房不占资源，免费额度友好。

const PEERJS_ROOM = 'easydrop-peerjs-bus';
const PEERJS_MAX_MSG = 256 * 1024; // SDP/ICE 报文上限（远大于实际尺寸）
const PEERJS_ALIVE_MS = 120000;

function pjSanitizeId(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('websocket required', { status: 426 });
    }
    const url = new URL(request.url);
    let topic;
    if (url.pathname.startsWith('/easydrop-peerjs')) {
      topic = PEERJS_ROOM; // 与 Pages 侧路由共用同一房间名
    } else {
      // 主题 = URL 路径（如 /easydrop-lan/v1/192.168.3.x/beacon），净化后作房间名
      topic = url.pathname.replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 120) || 'default';
    }
    const id = env.BEACON_ROOM.idFromName(topic);
    return env.BEACON_ROOM.get(id).fetch(request);
  }
};

export class BeaconRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // PeerJS socket 是否仍在心跳窗口内
  _pjAlive(ws) {
    try {
      const att = ws.deserializeAttachment();
      return !!(att && att.pj && Date.now() - (att.seen || 0) < PEERJS_ALIVE_MS);
    } catch (e) { return false; }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (url.pathname.startsWith('/easydrop-peerjs')) {
      // ---- PeerJS 兼容信令模式 ----
      const id = pjSanitizeId(url.searchParams.get('id'));
      if (!id) return new Response('bad id', { status: 400 });
      this.state.acceptWebSocket(server, ['pj:' + id]);
      // 同 ID 已有活连接（多窗口/实例）→ ID-TAKEN，客户端自动换后缀重试
      const dup = this.state.getWebSockets('pj:' + id).filter(w => w !== server && this._pjAlive(w));
      if (dup.length) {
        server.serializeAttachment({ pj: false }); // 标记为已拒 socket：消息一概忽略
        try { server.send(JSON.stringify({ type: 'ID-TAKEN' })); } catch (e) { /* noop */ }
        try { server.close(4001, 'id taken'); } catch (e) { /* noop */ }
      } else {
        server.serializeAttachment({ pj: true, id: id, seen: Date.now() });
        try { server.send(JSON.stringify({ type: 'OPEN' })); } catch (e) { /* noop */ }
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- 原有：发现信标广播房间 ----
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const data = typeof message === 'string' ? message : String(message);
    let att = null;
    try { att = ws.deserializeAttachment(); } catch (e) { /* noop */ }

    if (!att) {
      // 无附件 = 发现信标房连接：原广播逻辑（不回发给发送者）
      if (data.length > 512) return; // 心标很小，超大消息直接丢弃
      for (const other of this.state.getWebSockets()) {
        if (other === ws) continue;
        try { other.send(data); } catch (e) { /* 个别断连不影响其他人 */ }
      }
      return;
    }
    if (!att.pj) return; // 已拒/被顶替的 PeerJS socket：忽略

    // ---- PeerJS 信令总线 ----
    if (data.length > PEERJS_MAX_MSG) return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    att.seen = Date.now();
    try { ws.serializeAttachment(att); } catch (e) { /* noop */ }
    if (!msg || msg.type === 'HEARTBEAT') return; // 保活，无需转发

    const dst = pjSanitizeId(msg.dst);
    if (!dst) return;
    const targets = this.state.getWebSockets('pj:' + dst).filter(w => w !== ws && this._pjAlive(w));
    if (!targets.length) {
      // 目标未注册/已失活 → EXPIRE = 客户端立即收到 peer-unavailable
      try { ws.send(JSON.stringify({ type: 'EXPIRE', src: dst })); } catch (e) { /* noop */ }
      return;
    }
    const out = JSON.stringify({ type: msg.type, src: att.id, dst: dst, payload: msg.payload });
    for (const w of targets) {
      try { w.send(out); } catch (e) { /* 目标个别投递失败由拨号候选重试兜底 */ }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    let att = null;
    try { att = ws.deserializeAttachment(); } catch (e) { /* noop */ }
    if (!att || !att.pj) return; // 信标房间无需处理
    // 通知总线内其他注册端：该 peer 已下线（客户端清理其会话/拨号）
    const leave = JSON.stringify({ type: 'LEAVE', src: att.id });
    for (const w of this.state.getWebSockets()) {
      if (w === ws) continue;
      let a2 = null;
      try { a2 = w.deserializeAttachment(); } catch (e) { /* noop */ }
      if (!a2 || !a2.pj) continue;
      try { w.send(leave); } catch (e) { /* noop */ }
    }
  }
}
