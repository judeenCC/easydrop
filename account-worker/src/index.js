// EasyDrop 账号与云同步 Worker
// 提供：注册/登录（JWT）、好友列表与传输记录的云端存储
// 存储：KV 命名空间 EASYDROP_KV（需在 wrangler.toml / Cloudflare 控制台绑定）

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const USERNAME_RE = /^[a-z0-9]{1,8}$/;
const PASSWORD_RULES = [/\d/, /[a-z]/, /[A-Z]/, /[!-\/:-@\[-`{-~]/];
const PASSWORD_MAX_LEN = 16;
const PASSWORD_MIN_CLASSES = 2;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function getKV(env, key) {
  const raw = await env.EASYDROP_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function setKV(env, key, value) {
  await env.EASYDROP_KV.put(key, JSON.stringify(value));
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', ENC.encode(input));
  const arr = new Uint8Array(buf);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function makeJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64url = (obj) => btoa(String.fromCharCode(...new Uint8Array(ENC.encode(JSON.stringify(obj)))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = b64url(header) + '.' + b64url(payload);
  const key = await crypto.subtle.importKey('raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, ENC.encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return signingInput + '.' + sigB64;
}

async function verifyJwt(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const key = await crypto.subtle.importKey('raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signingInput = h + '.' + p;
    const sig = DEC.decode(await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)), ENC.encode(signingInput)));
    if (!sig) return null;
    const payload = JSON.parse(DEC.decode(Uint8Array.from(atob(p.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

const UID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genUid() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => UID_ALPHABET[b % UID_ALPHABET.length]).join('');
}

async function allocUid(env) {
  for (let i = 0; i < 10; i++) {
    const uid = genUid();
    if (!(await getKV(env, `uid:${uid}`))) return uid;
  }
  throw new Error('识别码分配失败');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
        },
      });
    }

    const secret = env.JWT_SECRET || 'easydrop-dev-secret-change-me';

    // ==================== Auth ====================
    if (path === '/api/auth/register' && method === 'POST') {
      const { username, password, name } = await request.json().catch(() => ({}));
      if (!username || !password) return err('缺少用户名或密码');
      if (!USERNAME_RE.test(username)) return err('用户名只能包含数字和小写字母，且不超过 8 位');
      if (password.length > PASSWORD_MAX_LEN || PASSWORD_RULES.filter(rule => rule.test(password)).length < PASSWORD_MIN_CLASSES) return err('密码需至少包含数字、大写字母、小写字母、符号中的 2 类，且不超过 16 位');
      const usernameKey = `user:username:${username}`;
      if (await getKV(env, usernameKey)) return err('该用户名已被注册');
      const userId = 'u_' + crypto.randomUUID();
      const uid = await allocUid(env);
      const user = {
        id: userId,
        uid,
        username,
        name: name || username,
        passwordHash: await sha256Hex(password),
        createdAt: Date.now(),
      };
      await setKV(env, usernameKey, user);
      await setKV(env, `user:id:${userId}`, user);
      await setKV(env, `uid:${uid}`, userId);
      const token = await makeJwt({ sub: userId, username, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }, secret);
      return json({ token, user: { id: userId, uid, username, name: user.name } });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const { username, password } = await request.json().catch(() => ({}));
      if (!username || !password) return err('缺少用户名或密码');
      const user = await getKV(env, `user:username:${username}`);
      if (!user || user.passwordHash !== (await sha256Hex(password))) return err('用户名或密码错误', 401);
      const token = await makeJwt({ sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }, secret);
      return json({ token, user: { id: user.id, uid: user.uid, username: user.username, name: user.name } });
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const token = (request.headers.get('authorization') || '').replace(/^Bearer\s/i, '');
      const payload = await verifyJwt(token, secret);
      if (!payload) return err('未登录或 token 已过期', 401);
      const user = await getKV(env, `user:id:${payload.sub}`);
      if (!user) return err('用户不存在', 404);
      return json({ user: { id: user.id, uid: user.uid, username: user.username, name: user.name } });
    }

    // ==================== Auth 中间件 ====================
    let authedUserId = null;
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s/i, '');
    if (token) {
      const payload = await verifyJwt(token, secret);
      if (payload) authedUserId = payload.sub;
    }

    const requireAuth = () => {
      if (!authedUserId) return err('未登录', 401);
      return null;
    };

    // ==================== 好友列表 ====================
    if (path === '/api/friends' && method === 'GET') {
      const r = requireAuth();
      if (r) return r;
      const friends = await getKV(env, `user:${authedUserId}:friends`) || [];
      return json({ friends });
    }

    if (path === '/api/friends' && method === 'POST') {
      const r = requireAuth();
      if (r) return r;
      const { name, deviceId } = await request.json().catch(() => ({}));
      if (!name || !deviceId) return err('缺少 name 或 deviceId');
      const friends = await getKV(env, `user:${authedUserId}:friends`) || [];
      if (friends.find(f => f.deviceId === deviceId)) return json({ friends });
      const friend = { id: 'f_' + crypto.randomUUID(), name, deviceId, createdAt: Date.now(), transferCount: 0 };
      friends.push(friend);
      await setKV(env, `user:${authedUserId}:friends`, friends);
      return json({ friends });
    }

    if (path.match(/^\/api\/friends\/([^/]+)$/) && method === 'DELETE') {
      const r = requireAuth();
      if (r) return r;
      const friendId = path.match(/^\/api\/friends\/([^/]+)$/)[1];
      const friends = await getKV(env, `user:${authedUserId}:friends`) || [];
      const next = friends.filter(f => f.id !== friendId);
      await setKV(env, `user:${authedUserId}:friends`, next);
      return json({ friends: next });
    }

    // ==================== 传输记录 ====================
    if (path === '/api/history' && method === 'GET') {
      const r = requireAuth();
      if (r) return r;
      const history = await getKV(env, `user:${authedUserId}:history`) || [];
      return json({ history });
    }

    if (path === '/api/history' && method === 'POST') {
      const r = requireAuth();
      if (r) return r;
      const entry = await request.json().catch(() => ({}));
      entry.t = entry.t || Date.now();
      entry.id = 'h_' + crypto.randomUUID();
      const history = await getKV(env, `user:${authedUserId}:history`) || [];
      history.unshift(entry);
      if (history.length > 100) history.length = 100;
      await setKV(env, `user:${authedUserId}:history`, history);
      return json({ history });
    }

    if (path === '/api/history/clear' && method === 'POST') {
      const r = requireAuth();
      if (r) return r;
      await setKV(env, `user:${authedUserId}:history`, []);
      return json({ ok: true });
    }

    // ==================== 识别码查询（添加好友 / 发送文件） ====================
    if (path === '/api/users/lookup' && method === 'GET') {
      const r = requireAuth();
      if (r) return r;
      const uid = (url.searchParams.get('uid') || '').trim().toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(uid)) return err('识别码为 8 位字母或数字');
      const targetId = await getKV(env, `uid:${uid}`);
      if (!targetId) return err('未找到该识别码对应的用户', 404);
      const target = await getKV(env, `user:id:${targetId}`);
      const device = await getKV(env, `user:${targetId}:device`);
      if (!device || !device.deviceId) return err('对方尚未登录过设备，暂时无法连接', 404);
      return json({ uid, name: target.name, deviceId: device.deviceId, self: targetId === authedUserId });
    }

    // ==================== 设备信息（用于好友直连识别） ====================
    if (path === '/api/device' && method === 'GET') {
      const r = requireAuth();
      if (r) return r;
      const device = await getKV(env, `user:${authedUserId}:device`) || {};
      return json({ device });
    }

    if (path === '/api/device' && method === 'POST') {
      const r = requireAuth();
      if (r) return r;
      const device = await request.json().catch(() => ({}));
      device.userId = authedUserId;
      device.updatedAt = Date.now();
      await setKV(env, `user:${authedUserId}:device`, device);
      return json({ device });
    }

    return json({ error: 'Not Found' }, 404);
  },
};
