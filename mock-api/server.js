// EasyDrop 账号云同步 本地 Mock 服务器
// 用于开发/本地测试登录、注册、好友与传输记录云端同步
// 接口与 account-worker/src/index.js 完全兼容
// 运行：node mock-api/server.js  （需先 npm install express）

const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'content-type, authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'easydrop-dev-secret-change-me';
const USERS = {};       // email -> user
const USERS_BY_ID = {}; // id -> user
const FRIENDS = {};     // userId -> friend[]
const HISTORY = {};     // userId -> entry[]

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(payload) {
  const signingInput = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url(payload);
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return signingInput + '.' + sig;
}
function verifyJwt(token) {
  try {
    const [h, p, s] = token.split('.');
    const key = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (key !== s) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64').toString());
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}
function auth(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s/i, '');
  const payload = verifyJwt(token);
  return payload ? payload.sub : null;
}

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '缺少 email 或密码' });
  const key = email.toLowerCase();
  if (USERS[key]) return res.status(400).json({ error: '该邮箱已注册' });
  const userId = 'u_' + crypto.randomUUID();
  const user = { id: userId, email: key, name: name || key.split('@')[0], passwordHash: sha256Hex(password), createdAt: Date.now() };
  USERS[key] = user; USERS_BY_ID[userId] = user;
  const token = makeJwt({ sub: userId, email: user.email, exp: Math.floor(Date.now() / 1000) + 7 * 86400 });
  res.json({ token, user: { id: userId, email: user.email, name: user.name } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '缺少 email 或密码' });
  const user = USERS[email.toLowerCase()];
  if (!user || user.passwordHash !== sha256Hex(password)) return res.status(401).json({ error: '邮箱或密码错误' });
  const token = makeJwt({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 7 * 86400 });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/auth/me', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录或 token 已过期' });
  const user = USERS_BY_ID[userId];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/friends', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  res.json({ friends: FRIENDS[userId] || [] });
});

app.post('/api/friends', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  const { name, deviceId } = req.body || {};
  if (!name || !deviceId) return res.status(400).json({ error: '缺少 name 或 deviceId' });
  let friends = FRIENDS[userId] || [];
  if (friends.find(f => f.deviceId === deviceId)) return res.json({ friends });
  const friend = { id: 'f_' + crypto.randomUUID(), name, deviceId, createdAt: Date.now(), transferCount: 0 };
  friends.push(friend); FRIENDS[userId] = friends;
  res.json({ friends });
});

app.delete('/api/friends/:id', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  let friends = FRIENDS[userId] || [];
  friends = friends.filter(f => f.id !== req.params.id);
  FRIENDS[userId] = friends;
  res.json({ friends });
});

app.get('/api/history', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  res.json({ history: HISTORY[userId] || [] });
});

app.post('/api/history', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  const entry = req.body || {};
  entry.t = entry.t || Date.now(); entry.id = 'h_' + crypto.randomUUID();
  let history = HISTORY[userId] || [];
  history.unshift(entry); if (history.length > 100) history.length = 100;
  HISTORY[userId] = history;
  res.json({ history });
});

app.post('/api/history/clear', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  HISTORY[userId] = [];
  res.json({ ok: true });
});

app.get('/api/device', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  res.json({ device: DEVICES[userId] || {} });
});

const DEVICES = {};
app.post('/api/device', (req, res) => {
  const userId = auth(req);
  if (!userId) return res.status(401).json({ error: '未登录' });
  const device = req.body || {}; device.userId = userId; device.updatedAt = Date.now();
  DEVICES[userId] = device;
  res.json({ device });
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Mock API listening on http://localhost:${PORT}`));
