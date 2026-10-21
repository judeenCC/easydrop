# EasyDrop 账号云同步 — 部署与使用说明

## 生产架构（当前已生效）

- 前端 `apiBase` 默认为空字符串（同源）。浏览器请求 `/api/*` 由 Pages 高级模式 `_worker.js` 反向代理到账号 Worker `https://easydrop-account.judiancj.workers.dev`。
- 这样客户端只需能访问 `https://easydrop-ady.pages.dev`，无需直连 `*.workers.dev`（后者在部分网络下不可达）。
- Pages `_worker.js` 源码在 `pages-deploy/_worker.js`，构建时复制到 `.deploy-cloudflare/_worker.js`；改动它之后需要重新触发 Pages 部署（推送 `main` 即可）。

## 本地开发：用 mock 服务器验证

本地静态服务器（如 `python -m http.server 8080`）不含 `/api/*` 路由，需先启动 mock：

```bash
node mock-api/server.js   # 监听 http://localhost:3456
```

在浏览器中打开页面并带上查询参数：

```
http://你的域名/easydrop-1.0.html?apiBase=http://localhost:3456
```

或本地直接打开：

```
file:///D:/Back_up/Dev/easy_dorp/easydrop-1.0.html?apiBase=http://localhost:3456
```

然后点右上角“登录” → 注册/登录，即可使用云端好友与传输记录。

> 注意：`file://` 协议下部分浏览器会限制 `fetch` 跨域，建议用本地静态服务器（如 `npx serve` 或 Python `http.server`）承接页面，再带 `?apiBase=` 访问。

### 方案二：生产部署到 Cloudflare Workers

1. 安装并登录 wrangler：
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. 创建 KV 命名空间并绑定：
   ```bash
   cd D:\Back_up\Dev\easy_dorp\account-worker
   wrangler kv:namespace create EASYDROP_KV
   ```
   把返回的 `id` 填入 `wrangler.toml` 的 `[[kv_namespaces]].id`（替换 `PLACEHOLDER_KV_ID`）。

3. 设置密钥并部署：
   ```bash
   wrangler secret put JWT_SECRET
   wrangler deploy
   ```

4. 得到 Worker URL（如 `https://easydrop-account.<子域>.workers.dev`），把它填进 `pages-deploy/_worker.js` 顶部的 `ACCOUNT_ORIGIN`；前端默认同源请求即可，无需再改 `apiBase`（调试用 `?apiBase=` 仍可覆盖）。

## 接口一致性

`mock-api/server.js` 与 `account-worker/src/index.js` 接口完全一致：
- `POST /api/auth/register` — 注册
- `POST /api/auth/login` — 登录
- `GET /api/auth/me` — 验证登录态
- `GET/POST/DELETE /api/friends` — 好友列表
- `GET/POST /api/history`、`POST /api/history/clear` — 传输记录
- `GET/POST /api/device` — 设备信息

前端已做“云端优先、本地缓存”：登录后自动从云端拉取好友与记录；本地增删改会异步推送到云端。`localStorage` 作为本地缓存，未登录或离线时仍可读写本地数据。
