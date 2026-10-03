// EasyDrop 局域网发现信标总线
// 客户端用原始 WebSocket 连接：wss://easydrop-beacon.<子域>.workers.dev/<主题路径>
// 主题（=URL 路径）映射到 Durable Object 房间，房内消息广播给其他连接。
// 走 443/WSS，无混合内容问题；空房休眠不占资源，免费额度友好。

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('websocket required', { status: 426 });
    }
    // 主题 = URL 路径（如 /easydrop-lan/v1/192.168.3.x/beacon），净化后作房间名
    const url = new URL(request.url);
    const topic = url.pathname.replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 120) || 'default';
    const id = env.BEACON_ROOM.idFromName(topic);
    return env.BEACON_ROOM.get(id).fetch(request);
  }
};

export class BeaconRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // 休眠式 API：连接托管给运行时，webSocketMessage 里按需取房内连接
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // 单纯中继：广播给同房其他连接，不回发给发送者（客户端无需过滤自发信标）
    const data = typeof message === 'string' ? message : String(message);
    if (data.length > 512) return; // 心标很小，超大消息直接丢弃
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(data); } catch (e) { /* 个别断连不影响其他人 */ }
    }
  }
}
