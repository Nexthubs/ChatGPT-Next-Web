# 使用 WordPress 登录状态保护 NextChat

登录校验通过环境变量配置，运行时读取 `.env.local`，修改后重启容器即可生效，
不需要重新构建镜像。

## 环境变量

```dotenv
AUTH_CHECK_URL=https://flow.nexthubs.cn/auth-check.php
AUTH_REDIRECT_URL=https://ai.nexthubs.cn/
```

- 两个变量都配置时才启用校验。
- 任意一个为空或未配置时，前端直接放行，Caddy 网关也直接返回 `204` 放行。
- 域名变化时只需要修改 `.env.local` 并重启容器。

## 接口

- `GET /api/auth-check`：返回登录状态 JSON，供前端使用。
- `GET /api/auth-gate`：供 Caddy `forward_auth` 使用。
  - 未配置认证：`204 No Content`（放行）
  - 已登录：`204 No Content`
  - 未登录：`302` 跳转到 `AUTH_REDIRECT_URL`

## Caddy 配置

```caddyfile
gpt.nexthubs.cn {
    route {
        # CORS 预检请求不鉴权
        @options method OPTIONS
        handle @options {
            header Access-Control-Allow-Origin "*"
            header Access-Control-Allow-Methods "GET, POST, OPTIONS"
            header Access-Control-Allow-Headers "User-Agent,Keep-Alive,Content-Type"
            header Access-Control-Max-Age "1728000"
            header Content-Type "text/plain; charset=UTF-8"
            respond "" 204
        }

        # 鉴权接口本身必须放行，否则会递归鉴权
        @auth_endpoint path /api/auth-check /api/auth-check/ /api/auth-gate /api/auth-gate/
        handle @auth_endpoint {
            reverse_proxy 127.0.0.1:3001
        }

        # 所有业务 API 都先经过登录校验
        @protected path /api/*
        forward_auth @protected 127.0.0.1:3001 {
            uri /api/auth-gate
            copy_headers X-Auth-User
        }

        reverse_proxy 127.0.0.1:3001
    }

    header {
        Access-Control-Allow-Origin "*"
        Access-Control-Allow-Methods "GET, POST, OPTIONS"
        Access-Control-Allow-Headers "User-Agent,Keep-Alive,Content-Type"
    }
}
```

Caddy 配置不需要随域名变化，是否拦截由应用读取 `.env.local` 后决定。

## 为什么不能直接 forward_auth 到 auth-check.php

`auth-check.php` 未登录时返回的是：

```http
HTTP/2 200
content-type: application/json

{"logged_in":false}
```

Caddy 的 `forward_auth` 只根据状态码判断，`200` 会被当成“已登录”。
因此需要 `/api/auth-gate` 把 JSON 结果转换成：

- 放行：`204`
- 拦截：`302`

## 验证

```bash
# 已启用认证且未登录时：302
curl -i http://127.0.0.1:3001/api/auth-gate

# 未配置认证时：204
curl -i http://127.0.0.1:3001/api/auth-gate

# 未登录时业务 API 应被 Caddy 拦截
curl -i https://gpt.nexthubs.cn/api/config

# 页面本身由前端 AuthGuard 控制跳转
curl -I https://gpt.nexthubs.cn/
```

## 说明

- 页面 HTML 由前端 `AuthGuard` 控制跳转，所有 `/api/*` 由 Caddy 强制鉴权。
- 即使绕过前端，直接调用 `/api/openai` 等接口也会被 Caddy 拦截。
- Cookie 必须作用在 `.nexthubs.cn` 上，否则 `gpt.nexthubs.cn`
  收不到 WordPress 登录 Cookie。
