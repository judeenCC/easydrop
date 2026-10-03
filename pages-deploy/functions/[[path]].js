// 全捕获路由：Pages 静态资源之外的路径走到这里
// WebSocket 升级请求 → 按路径主题分派到 Durable Object 广播房间
// （BeaconRoom 类定义在独立 Worker easydrop-beacon 中，经 DO 绑定调用；
//   客户端全程只与本 Pages 域名通信，443/WSS 无混合内容问题）
export async function onRequest(ctx) {
  const { request, env } = ctx;
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Not Found', { status: 404 });
  }
  const url = new URL(request.url);
  // 主题 = URL 路径（如 /easydrop-lan/v1/192.168.3.x/beacon），净化后作房间名
  const topic = url.pathname.replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 120) || 'default';
  const id = env.BEACON_ROOM.idFromName(topic);
  return env.BEACON_ROOM.get(id).fetch(request);
}
