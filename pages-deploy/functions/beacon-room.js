// Durable Object：按主题（网段）分房的 WebSocket 广播
// 房内消息只中继给其他连接，不回发（客户端无需过滤自发信标）
export class BeaconRoom {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // 休眠式 API：连接托管给运行时，空房不占资源
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const data = typeof message === 'string' ? message : String(message);
    if (data.length > 512) return; // 心标很小，超大消息直接丢弃
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(data); } catch (e) { /* 个别断连不影响其他人 */ }
    }
  }
}
