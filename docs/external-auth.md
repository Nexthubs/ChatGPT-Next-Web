# WordPress 登录认证部署

## 应用行为

运行时配置：

```env
AUTH_CHECK_URL=https://flow.nexthubs.cn/auth-check.php
AUTH_REDIRECT_URL=https://ai.nexthubs.cn/
```

可以不配置 `CODE`。配置 `AUTH_CHECK_URL` 后，应用服务端将当前请求的 Cookie
转交给固定的 HTTPS 认证地址，只有 JSON 布尔值 `logged_in: true` 才通过。
字符串 `"true"`、数字 `1`、缺少字段均不通过。不会转发客户端提供的
Authorization 或 X-Auth-User，也不会跟随认证接口重定向。

- 未登录打开页面：307 跳转到固定的 `AUTH_REDIRECT_URL`。
- 未登录调用 API：401 JSON，不调用模型或其他业务接口。
- 认证超时（5 秒）、网络异常、非 JSON 或认证服务异常：503，拒绝业务调用。
- `/api/auth-gate`、`/api/auth-check` 由中间件处理：已登录 200，
  未登录 401，认证服务异常或未配置 AUTH_CHECK_URL 时 503。带尾斜线时，Next.js 先以 308 跳转到无尾斜线路径，再执行同样校验。
- 登录判断不缓存，响应包含 `private, no-store`。WordPress/CDN 也必须禁止缓存认证响应。
- API 路由自身也验证会话，不信任 Caddy 传入的身份头。Next.js 外部 API 重写在中间件检查。
- 页面 POST（包括 Server Actions）也需要登录。MCP 保留原有 ENABLE_MCP/CODE 独立限制。
- 未配置 AUTH_CHECK_URL 时保留原有 CODE 模式；因此生产环境不要删除这个变量。
- 当前实现用于有服务端的 standalone 部署，静态 export 不能提供认证或 API 保护。

已登录用户仍可携带自己的有效 Cookie 使用 curl/脚本。这与网页调用使用相同身份，
不能靠隐藏地址、Referer 或 CORS 阻止。此方案保证未登录用户不能调用；如需限制已登录
用户的用量，需另外实现配额和限流。

## 必须确认 Cookie 能跨子域发送

auth-check.php 中的 `is_user_logged_in()` 读取 WordPress 登录 Cookie。
仅在 flow.nexthubs.cn 登录，并不保证 Cookie 会发送到 chat.nexthubs.cn。
PHP 设置 CORS 头不能改变 Cookie 的 Domain 或 Path。

在浏览器开发者工具 Application/Storage → Cookies 中检查
`wordpress_logged_in_*`，然后检查访问 chat.nexthubs.cn 的请求：

- Domain 必须覆盖 chat.nexthubs.cn，例如 `.nexthubs.cn`，不能仅为 flow.nexthubs.cn。
- Path 应为 `/`，HTTPS 使用 Secure；可以保留 HttpOnly，不需要前端读取 Cookie。
- 打开 chat.nexthubs.cn 时，Network 请求中应实际携带该登录 Cookie。
- 不要将 Cookie 的值、完整请求头或 logout_url 中的 nonce 发到聊天或日志里。

若所有子域均受你控制且可信，可在 WordPress 的 wp-config.php 加载 wp-settings.php
之前设置（已有定义时修改原定义，不要重复定义）：

```php
define('COOKIE_DOMAIN', '.nexthubs.cn');
```

这会扩大 WordPress Cookie 的发送范围，必须信任所有相关子域。若 WordPress 安装路径
导致登录 Cookie Path 不是 `/`，还需按实际站点配置调整 COOKIEPATH/SITECOOKIEPATH。
修改后清除旧域 Cookie，重新登录，再验证请求；不要仅凭配置文件判断成功。
若不能共享域 Cookie，需要单独的 SSO 授权码/会话交换方案，本实现未包含该流程。

## WordPress 认证接口

你现有的 JSON 判断逻辑可以继续使用，应用会把 HTTP 200 + logged_in:false 转为 401。
但请在 WordPress 响应中添加禁止缓存，并移除任意回显 Origin 的 CORS 逻辑。
本方案由服务端调用，不依赖浏览器跨域请求，也不需要开放 CORS。
可采用以下最小响应（无需返回 email、roles 或带 nonce 的 logout_url）：

```php
<?php
require_once __DIR__ . '/wp-load.php';
nocache_headers();
header('Cache-Control: private, no-store, max-age=0');
header('Vary: Cookie');
header('Content-Type: application/json; charset=utf-8');
if (!is_user_logged_in()) {
    echo wp_json_encode(['logged_in' => false]);
    exit;
}
$user = wp_get_current_user();
echo wp_json_encode([
    'logged_in' => true,
    'user' => ['id' => (int) $user->ID],
]);
exit;
```

这只是服务器配置参考，仓库内的改动不会修改你的 WordPress。

## Caddy 和源站

可使用同目录的 `external-auth.Caddyfile` 参考配置。保留 forward_auth 时，正常业务
请求会在 Caddy 和应用内各检查一次登录。应用已有页面跳转，不需要 Caddy 解析 JSON。
也可以只保留反代，让应用独立完成认证，但必须使用本次更新的镜像。

`X-Auth-User` 仅是辅助信息，不是凭证。不要据此跳过应用的会话验证。
过滤外部 `X-Middleware-Subrequest` 头作为额外防护；依赖已从 Next.js 14.1.1 更新至
14.2.35，包含已公开的中间件绕过补丁。此项不是对整个依赖树的安全审计。

将应用端口限制到 Caddy 所在网络，禁止通过公网 IP、IPv6、其他域名或旧容器绕开。
当前 compose 使用远程 `imzhaozhao/chat-next-web:latest`，单纯重启不会使用本地修复。
需构建包含本次源码的镜像，更新部署并注入环境变量。不要直接把本地 .env.local
复制到镜像，docker-compose 的 env_file 用于运行时注入。

## 通用代理变化

通用代理默认仅允许精确的 `https://api.openai.com`。如插件需要其他地址，管理员可设置：

```env
PROXY_ALLOWED_ORIGINS=https://trusted-plugin.example
```

只接受完整 HTTPS origin，不带路径、尾斜线或通配符。只加入可信目标，禁止内网、
元数据地址及会将凭据转发给第三方的服务。系统 OpenAI Key 只发送给精确的 OpenAI origin，
其他目标不会注入系统 Key。未列入允许列表的插件代理请求会返回 403。

## 发布后验收

1. 无 Cookie 访问首页应 307，Location 为 https://ai.nexthubs.cn/。
2. 无 Cookie 请求 /api/auth-gate、/api/config 或模型 API 应 401，且不触发上游模型。
3. 伪造 X-Auth-User、Authorization 或 X-Middleware-Subrequest 不能获得登录身份。
4. 正常登录后首页可访问，/api/auth-gate 返回 200，/api/config 可访问。
5. 登出、Cookie 过期后，同样的 API 再次返回 401。
6. 认证服务异常时，有 Cookie 的请求应 503，不消耗模型额度。
7. 登录用户使用伪造 OpenAI 主机名调用通用代理应 403，不向目标发送 Key。
8. 从公网检查源站端口及其他入口不可绕过；检查 CDN 没有缓存登录状态和用户页面。

本地测试使用模拟认证响应，不能替代真实 WordPress Cookie、Caddy 和线上镜像的验收。

## 本次本地验证

- Jest：38 个测试套件、206 项测试通过，包含新增的 32 项认证/代理回归测试。
- 生产构建：完成，Next.js 14.2.35；构建期间全项目 ESLint 在既有
  app/constant.ts 上触发 unused-imports 插件异常，不能据此声称全项目 lint 通过。
  另有原有 CSS 和实时语音可选依赖警告。
- 修改的应用文件：独立 ESLint 和 TypeScript 检查通过。
- 本机生产服务 + HTTPS 认证桩：23 项 HTTP 检查通过，没有调用真实模型。
- 真实 WordPress Cookie、线上 Caddy 配置、线上镜像：未验收，未部署或修改。

复现 HTTP 检查需本机 Node.js 22+、OpenSSL 以及已完成的生产构建：

```sh
yarn build
node scripts/test-external-auth-http.mjs
```

脚本只监听本机临时端口，使用临时证书和虚拟 Key，结束时清理进程及证书。
