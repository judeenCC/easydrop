// EasyDrop Pages 高级模式 Worker
// 职责：1) WebSocket 升级请求 → 按路径主题分派到 Durable Object 广播房间
//       （BeaconRoom 类定义在独立 Worker easydrop-beacon，经 DO 绑定调用；
//         客户端全程只与本 Pages 域名通信，443/WSS 无混合内容问题）
//       2) /easydrop-peerjs*：自建 PeerJS 兼容信令总线（DO 单房内按注册 ID
//         精确投递；拨号目标不存在立即回 EXPIRE）。第三方 0.peerjs.com 云端
//         的 offer 中继被阻断时拨号会静默挂死，这条自建通道与 presence 发现
//         总线同域名，可达性完全一致
//       3) /turn-creds：Cloudflare Realtime TURN 凭证发放（走官方 REST，
//         绝不做本地 HMAC 铸造）：
//         POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers
//         Authorization: Bearer {TURN_KEY_API_TOKEN}；body {"ttl": 7200}
//         - 官方 201 返回 iceServers（含 stun: / turn: / turns: 组），过滤
//           端口 53 的备用端口条目后透传给前端
//         - 服务端缓存至「过期前 10 分钟」，期间复用同一份
//         - 限流：每 IP 每分钟 5 次、每天 200 次（isolate 内存，尽力而为）
//         - 每日凭证发放闸门 TURN_DAILY_MAX_ISSUES（默认 20 次），计数走
//           Workers KV 绑定 TURN_QUOTA（key 按日期），超限 503 + 剩余头
//         - TURN_KEY_API_TOKEN 绝不出现在任何响应或日志
//       4) 其余请求一律回退静态资源
// 注：账号系统已下线，/api/* 不再代理（静态回退会对这些路径返回 404）

const TURN_TTL_SECONDS = 7200;                       // 凭证时长：2 小时
const TURN_CACHE_SAFETY_MS = 10 * 60 * 1000;         // 过期前 10 分钟缓存失效
const TURN_RATE_PER_MINUTE = 5;                      // 每 IP 每分钟
const TURN_RATE_PER_DAY = 200;                       // 每 IP 每天
const TURN_DAILY_MAX_DEFAULT = 20;                   // 每日发放闸门默认值
const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys/';

// isolate 内存限流桶：ip → { minuteKey, minuteCount, dayKey, dayCount }
const turnRateBuckets = new Map();
// isolate 内存凭证缓存：{ iceServers, issuanceAt, ttl }
let turnCredsCache = null;
// C2：KV 共享缓存读侧余命守卫（毫秒）。即使 KV 尚未到点自动删除，余命
// 剩 <600s 也视为失效——客户端拿这种凭证去新建长传输，TURN 分配可能在
// 传输中途失效（表现为传到一半断流）
const TURN_KV_RESIDUAL_GUARD_MS = 600 * 1000;

function turnClientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For') || 'unknown';
}

// C1：调试点常量时间比对。?debug=1 必须配 k=<TURN_DEBUG_TOKEN>（Pages
// custom secret，生成建议 openssl rand -hex 16）比对通过才视为开启；
// 无 secret/无 token/比对失败 → 一律按未开（不出调试头、不回上游详情）。
// 穷举防线由既有 per-IP 限流（5/min + 200/day）兜底
function turnDebugTokenMatch(expect, got) {
  expect = String(expect || '');
  got = String(got || '');
  if (!expect || expect.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function turnRateAllow(ip, now) {
  const minuteKey = Math.floor(now / 60000);
  const dayKey = Math.floor(now / 86400000);
  let b = turnRateBuckets.get(ip);
  if (!b || b.minuteKey !== minuteKey) { b = Object.assign(b || {}, { minuteKey, minuteCount: 0 }); }
  if (b.dayKey !== dayKey) { b.dayKey = dayKey; b.dayCount = 0; }
  if (b.minuteCount >= TURN_RATE_PER_MINUTE || b.dayCount >= TURN_RATE_PER_DAY) {
    turnRateBuckets.set(ip, b);
    return false;
  }
  b.minuteCount++; b.dayCount++;
  turnRateBuckets.set(ip, b);
  if (turnRateBuckets.size > 5000) turnRateBuckets.clear(); // 防内存增长
  return true;
}

// 过滤端口 53 的备用端口条目（官方文档：浏览器会拦截 53 端口导致超时）。
// 注意按「端口位精确判定」而非子串——否则 :5349（合法 TURN TLS 端口）会被误杀
function turnUrlPortExcluded(u) {
  const q = String(u).indexOf('?');
  const hostPart = q >= 0 ? String(u).slice(0, q) : String(u);
  const m = hostPart.match(/:(\d+)$/);
  return !!(m && m[1] === '53');
}

function turnSanitizeIceServers(iceServers) {
  const out = [];
  (iceServers || []).forEach(entry => {
    if (!entry) return;
    let urls = entry.urls;
    if (typeof urls === 'string') urls = [urls];
    if (!Array.isArray(urls)) return;
    urls = urls.filter(u => !turnUrlPortExcluded(u));
    if (!urls.length) return; // 该组全部命中 53 → 整组剔除（通常 stun/turn 分组不会如此）
    const e = { urls, username: entry.username, credential: entry.credential };
    if (e.username === undefined) delete e.username;
    if (e.credential === undefined) delete e.credential;
    out.push(e);
  });
  return out;
}

function turnCredsUsable() {
  if (!turnCredsCache) return false;
  const hardExpiry = turnCredsCache.issuanceAt + turnCredsCache.ttl * 1000;
  return hardExpiry - TURN_CACHE_SAFETY_MS > Date.now();
}

// L2 共享缓存（KV）：isolate 内存缓存只在单实例有效，边缘多实例会各自铸造、
// 白白扣每日配额。缓存的是「短时效凭证本身」（非 TURN_KEY_API_TOKEN），
// 且随 KV TTL 在硬过期时自动删除，静止风险窗口 ≤ 2 小时
const TURN_KV_CREDS_KEY = 'turn:creds';

async function turnSharedGet(env) {
  if (!env.TURN_QUOTA) return null;
  try {
    const raw = await env.TURN_QUOTA.get(TURN_KV_CREDS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o) return null;
    // C2 新结构：{ creds: [{username, credential, urls}], mintedAt, ttl } ——
    // 读侧用 mintedAt + ttl 算余命；余命 < 600s 弃用（宁可本 isolate 重铸，
    // 不把临近到期的凭证发给客户端去新建长传输）
    if (Array.isArray(o.creds) && o.creds.length && o.mintedAt && o.ttl) {
      if (o.mintedAt + o.ttl * 1000 - TURN_KV_RESIDUAL_GUARD_MS <= Date.now()) return null;
      return { iceServers: o.creds, issuanceAt: o.mintedAt, ttl: o.ttl };
    }
    // r21 旧结构兼容：{ iceServers, issuanceAt, ttl } —— 余命照常复算
    //（过期前 10 分钟视为失效），并按新规只回 turn/turns 组（stun 组不缓存）
    if (Array.isArray(o.iceServers) && o.issuanceAt && o.ttl) {
      if (o.issuanceAt + o.ttl * 1000 - TURN_CACHE_SAFETY_MS <= Date.now()) return null;
      const turns = (o.iceServers || []).filter(g => {
        if (!g) return false;
        const u = Array.isArray(g.urls) ? g.urls.join(' ') : (g.urls || '');
        return /turns?:/.test(u);
      });
      if (!turns.length) return null;
      return { iceServers: turns, issuanceAt: o.issuanceAt, ttl: o.ttl };
    }
    return null;
  } catch (e) { return null; }
}

// 调官方 REST 铸造。任何失败都只记状态码，绝不记 token/request body
async function turnMintViaApi(env, debug) {
  const url = TURN_API_BASE + env.TURN_KEY_ID + '/credentials/generate-ice-servers';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS })
    });
    if (!res.ok) {
      console.error('turn 调官方 REST 失败: HTTP', res.status);
      // 调试通道（?debug=1）：仅在调试点开启时回传上游状态码与安全截断的响应体。
      // 绝不含 token；审计场景下临时用，平时不开
      if (debug) {
        const txt = await res.text().catch(() => '');
        throw new turnUpstreamError(res.status, txt.slice(0, 200));
      }
      throw new turnUpstreamError(res.status);
    }
    const data = await res.json();
    const iceServers = turnSanitizeIceServers(data && data.iceServers);
    if (!iceServers.length) {
      console.error('turn 官方响应缺 iceServers 或过滤后为空');
      throw new turnUpstreamError(res.status, 'empty-iceServers');
    }
    turnCredsCache = { iceServers, issuanceAt: Date.now(), ttl: TURN_TTL_SECONDS };
    // 双写 L2：KV 共享缓存。C2 三收紧：
    // 1) stun 组不缓存——官方返回常附带 stun 组，本地已内置多组并探，缓存
    //    只留 turn/turns 组（信封最小化）
    // 2) 值结构改为 { creds: [{username, credential, urls}], mintedAt, ttl }：
    //    读侧可由 mintedAt+ttl 直接算余命
    // 3) expirationTtl = floor(ttl * 0.9) = 6480s：KV 自动删除先于官方硬过期
    //    10%，叠加读侧 600s 余命守卫双保险
    if (env.TURN_QUOTA) {
      try {
        const turnOnly = iceServers.filter(g => {
          if (!g) return false;
          const u = Array.isArray(g.urls) ? g.urls.join(' ') : (g.urls || '');
          return /turns?:/.test(u);
        });
        if (turnOnly.length) {
          await env.TURN_QUOTA.put(TURN_KV_CREDS_KEY,
            JSON.stringify({ creds: turnOnly, mintedAt: turnCredsCache.issuanceAt, ttl: TURN_TTL_SECONDS }),
            { expirationTtl: Math.floor(TURN_TTL_SECONDS * 0.9) });
        }
      } catch (e) { /* KV 写失败不阻断（L1 仍有效）*/ }
    }
    return turnCredsCache;
  } catch (e) {
    if (e instanceof turnUpstreamError) throw e;
    console.error('turn 官方 REST 调用异常:', e && e.name);
    throw new turnUpstreamError(0, (e && e.name) + '');
  }
}

function turnUpstreamError(status, body) {
  this.status = status;
  this.body = body || '';
}

// 每日发放闸门：KV（TURN_QUOTA）按日期 key 计数。仅真实铸造扣减
async function turnQuotaGate(env, mint) {
  const max = parseInt(env.TURN_DAILY_MAX_ISSUES || String(TURN_DAILY_MAX_DEFAULT), 10) || TURN_DAILY_MAX_DEFAULT;
  if (!env.TURN_QUOTA) return { ok: true, remaining: max - 1 }; // KV 未绑定（本地/异常）时放宽
  const dayKey = 'q:' + new Date().toISOString().slice(0, 10);
  let used = 0;
  try { used = parseInt((await env.TURN_QUOTA.get(dayKey)) || '0', 10) || 0; } catch (e) { used = 0; }
  if (used >= max) return { ok: false, remaining: 0 };
  if (mint) {
    used++;
    try {
      await env.TURN_QUOTA.put(dayKey, String(used), { expirationTtl: 172800 }); // 2 天后自动清理
    } catch (e) { /* KV 写失败也不阻断发放（尽力而为）*/ }
  }
  return { ok: true, remaining: Math.max(0, max - used) };
}

async function handleTurnCreds(request, env) {
  // C1 门槛：?debug=1 仅当 k=<TURN_DEBUG_TOKEN> 通过常量时间比对时才视为
  // 开启；未通过一律按未开（不出调试头、不回上游状态码/响应体）
  const url = new URL(request.url);
  let debug = url.searchParams.get('debug') === '1';
  if (debug) {
    debug = turnDebugTokenMatch(env.TURN_DEBUG_TOKEN, url.searchParams.get('k'));
    if (!debug) console.warn('turn debug 访问被拒（缺 TURN_DEBUG_TOKEN secret 或 token 不符）');
  }
  // 1) 每 IP 基础限流
  const ip = turnClientIp(request);
  if (!turnRateAllow(ip, Date.now())) {
    return new Response('rate limited', { status: 429, headers: { 'Content-Type': 'text/plain' } });
  }
  // 2) secret/配置缺失 → 明确走降级（与旧语义一致：前端收到 503 即纯 STUN）。
  //    诊断头只给 typeof/长度指标，绝不输出值本身
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    const diag = 'key_id:' + typeof env.TURN_KEY_ID + '/len' + String(env.TURN_KEY_ID || '').length +
                 ' token:' + typeof env.TURN_KEY_API_TOKEN + '/len' + String(env.TURN_KEY_API_TOKEN || '').length;
    return new Response(debug ? ('turn not configured [' + diag + ']') : 'turn not configured', {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
  // 3) L1 缓存命中：直接复用（不扣发放额度，仍报告剩余）
  let quota = await turnQuotaGate(env, false);
  if (turnCredsUsable() && quota.ok) {
    const body = {
      iceServers: turnCredsCache.iceServers,
      expiresAt: turnCredsCache.issuanceAt + turnCredsCache.ttl * 1000,
      cached: true
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Turn-Quota-Remaining': String(quota.remaining)
      }
    });
  }
  // 3b) L2 共享缓存（KV）：跨 isolate 复用同一份凭证，避免重复铸造扣配额
  if (quota.ok) {
    const shared = await turnSharedGet(env);
    if (shared) {
      turnCredsCache = { iceServers: shared.iceServers, issuanceAt: shared.issuanceAt, ttl: shared.ttl };
      const body = {
        iceServers: shared.iceServers,
        expiresAt: shared.issuanceAt + shared.ttl * 1000,
        cached: true
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Turn-Quota-Remaining': String(quota.remaining)
        }
      });
    }
  }
  // 4) 每日发放闸门（真实铸造前检查 + 扣减）
  const gate = await turnQuotaGate(env, true);
  if (!gate.ok) {
    return new Response('turn daily quota exceeded', {
      status: 503,
      headers: { 'Content-Type': 'text/plain', 'X-Turn-Quota-Remaining': '0' }
    });
  }
  // 5) 官方 REST 铸造（失效前先探缓存：与上面请求竞态时以最新为准）
  let creds;
  try {
    creds = turnCredsUsable() ? turnCredsCache : await turnMintViaApi(env, debug);
  } catch (e) {
    const status = (e && e.status) || 0;
    const headers = {
      'Content-Type': 'text/plain',
      'X-Turn-Quota-Remaining': String(gate.remaining),
      'X-Turn-Upstream-Status': String(status)
    };
    if (debug && e && e.body) headers['X-Turn-Upstream-Body'] = e.body.slice(0, 200);
    return new Response(debug ? ('turn upstream error: ' + status + (e && e.body ? '\n' + e.body : '')) : 'turn upstream error',
      { status: 502, headers });
  }
  const body = { iceServers: creds.iceServers, expiresAt: creds.issuanceAt + creds.ttl * 1000, cached: false };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Turn-Quota-Remaining': String(gate.remaining)
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/turn-creds') {
      return handleTurnCreds(request, env);
    }

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
