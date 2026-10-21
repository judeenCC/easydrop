// EasyDrop Pages 高级模式 Worker
// 职责：1) WebSocket 升级请求 → 按路径主题分派到 Durable Object 广播房间
//       （BeaconRoom 类定义在独立 Worker easydrop-beacon，经 DO 绑定调用；
//         客户端全程只与本 Pages 域名通信，443/WSS 无混合内容问题）
//       2) /api/* 反向代理到账号 Worker（客户端只需能访问本 Pages 域名，
//          无需直连 *.workers.dev；Cloudflare 内网回源不受客户端网络限制）
//       3) 其余请求一律回退静态资源
const ACCOUNT_ORIGIN = 'https://easydrop-account.judiancj.workers.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const target = ACCOUNT_ORIGIN + url.pathname + url.search;
      return fetch(new Request(target, request));
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      // 主题 = URL 路径（如 /easydrop-lan/v1/192.168.3.x/beacon），净化后作房间名
      const topic = url.pathname.replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 120) || 'default';
      const id = env.BEACON_ROOM.idFromName(topic);
      return env.BEACON_ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
}
