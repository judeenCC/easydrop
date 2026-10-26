// EasyDrop Pages 高级模式 Worker
// 职责：1) WebSocket 升级请求 → 按路径主题分派到 Durable Object 广播房间
//       （BeaconRoom 类定义在独立 Worker easydrop-beacon，经 DO 绑定调用；
//         客户端全程只与本 Pages 域名通信，443/WSS 无混合内容问题）
//       2) /easydrop-peerjs*：自建 PeerJS 兼容信令总线（DO 单房内按注册 ID
//         精确投递；拨号目标不存在立即回 EXPIRE）。第三方 0.peerjs.com 云端
//         的 offer 中继被阻断时拨号会静默挂死，这条自建通道与 presence 发现
//         总线同域名，可达性完全一致
//       3) 其余请求一律回退静态资源
// 注：账号系统已下线，/api/* 不再代理（静态回退会对这些路径返回 404）
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/easydrop-peerjs')) {
      if (request.headers.get('Upgrade') === 'websocket') {
        // 全部信令连接进同一 DO 房间，由 BeaconRoom 按 ID 精确路由
        const id = env.BEACON_ROOM.idFromName('easydrop-peerjs-bus');
        return env.BEACON_ROOM.get(id).fetch(request);
      }
      // PeerJS 客户端仅在无固定 ID 时才请求随机 ID（GET .../peerjs/id?ts=）。
      // 应用全部使用固定 ID；此处兜底实现协议端点，保持完整兼容
      if (url.pathname.endsWith('/id')) {
        const rid = 'ed-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        return new Response(rid, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('not found', { status: 404 });
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
