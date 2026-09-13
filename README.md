# dsh-feishu-auth

给 DSH Web 页面加一道飞书登录：**没登录就什么都拿不到**——首页、静态资源、`/api` 全都拦。挂在哪个地址（LAN IP / 隧道域名 / localhost）就保护哪个地址。

```
浏览器 ─► 任何地址
            ├─ 未登录 → 302 飞书授权页（API 请求返回 401 JSON）
            └─ 飞书回调验证通过 → 签发会话 Cookie → 交给 DSH 换它自己的 Cookie → 正常页面
```

## 前置：飞书后台两项设置

在你的应用（开发者后台 → 该应用）里：

1. **安全设置 → 重定向 URL**：添加 `<你访问用的地址>/feishu-auth/callback`，例如
   `https://xxx.trycloudflare.com/feishu-auth/callback`、`http://192.168.1.23:3080/feishu-auth/callback`。
   不支持通配符，最多 300 条；地址换了（比如临时隧道重启换了域名）要重新加一条。
2. **可用范围**：这个范围就是「谁可以登录」，建议直接设成你自己或你的部门。

权限（scope）不用申请：`open_id`、`union_id`、`tenant_key`、姓名都能直接拿到。

## 启动

行已经写在 `~/.dsh/profiles/web/cordis.patch.yml` 里，默认启用，凭证读 `~/.dsh/.env`：

```bash
dsh web --no-open --host 0.0.0.0 --port 3080 --trusted-host <你的隧道域名>
```

> `--host 0.0.0.0` 才能让局域网访问；只走隧道的话 `127.0.0.1` 也行。
> 凭证（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）只在**启动时**读取，改了要重启。

**临时停用**（例如凭证写错、被关在门外）：

```bash
dsh --profile web --patch ~/.dsh/plugins/dsh-feishu-auth/disable.patch.yml --no-open --host 0.0.0.0 --port 3080
```

## 配置

就 4 项，写在 patch 行的 `config:` 下：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `appId` / `appSecret` | 环境变量 | 缺省读 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`；都拿不到时**拒绝一切访问**并在页面和日志里说明原因 |
| `allowedUsers` | `[]` | 留空 = 放行「能使用本应用的任意飞书成员」；填了就只放行列出的 `open_id` / `union_id` / `user_id` |
| `sessionMaxAgeDays` | `14` | 会话有效期，过期重新登录 |

`allowedUsers` 里该填什么：被拒的人会在页面上看到**他自己**的 `open_id`，抄进去**保存即可，不用重启**——profile 的 patch 层是热加载的（`dsh.profile.patchReload: live`），日志里会立刻出现一条新的「飞书登录已挂载」行，`允许范围` 随之改变。日志里也会打印被拒者的 `open_id`。

名单只在**登录回调那一刻**判定，所以改名单不会踢掉已经登录的会话（已签发的会话 Cookie 照用到期或登出为止）。

**什么时候要重启**：

| 改动 | 生效方式 |
| --- | --- |
| `allowedUsers`、`sessionMaxAgeDays`（配置项） | 保存即生效，无需重启 |
| `appId` / `appSecret` | 走 `~/.dsh/.env`，**只在启动时读取**，必须重启 |
| 加 / 删 / 停用整行（`disabled: true`、删除 `- id: feishu-auth`） | 结构变更不会热生效，必须重启（实测挂载后 45 秒仍未摘除） |

## 运维

**日志**（`dsh web` 的终端，也可 `grep feishu-auth /tmp/dsh-web.log`）：

```
feishu-auth[info] 飞书登录已挂载  prefix=/feishu-auth  允许范围=本应用可用范围内的任意成员  会话有效期=14 天
feishu-auth[info] 网关自检通过（未登录 → HTTP 401，已登录 → HTTP 404）
feishu-auth[warn] 拒绝未认证请求 GET / host=xxx.trycloudflare.com from 45.149.92.7 via 127.0.0.1 (no-cookie)
feishu-auth[info] 登录成功 name=张三 open_id=ou_xxx tenant=tk_xxx from 203.0.113.5 via 127.0.0.1
```

**当前状态**：`GET /feishu-auth/status` 返回你自己的登录状态；登出用 `GET /feishu-auth/logout`。

| 现象 | 原因 |
| --- | --- |
| 所有请求 503，页面说「未就绪」 | 进程环境里没有凭证。确认 `~/.dsh/.env`，然后重启 |
| 飞书报 `redirect_uri unmatch` | 回调地址没登记或与访问地址不一致（隧道换域名了？） |
| 飞书报 `20010` / 无应用使用权限 | 该账号不在应用可用范围内，或应用版本没发布 |
| 换地址后要重新登录 | 正常：Cookie 按来源隔离，https 隧道与 `http://127.0.0.1` 各算一处 |
| 想彻底回退 | 把 patch 里那行删掉，或加 `disabled: true`，然后**重启**（结构变更不会热生效） |

## 已知边界

- 拦截点是运行中 `webServer` 的 `match(pathname)` 分发点（当前 dsh 没有全局中间件钩子）。找不到该分发点时插件**拒绝启动**并报错，不会静默放过。dsh 升级后若这里变了要同步适配。该分发点是 Cordis 服务成员，**每次读取都返回新的包装 Proxy**，因此挂载/卸载一律按符号标记识别自己的层、按 server 记录当前层，不做身份比较（否则卸载静默失效，网关会永久粘住）。
- WebSocket（`/api/remote.mux`）不在拦截范围，但 DSH 自己会校验它签名的 Cookie，而那个 Cookie 只有走完飞书登录才拿得到。
- 登录成功后会经 DSH 的令牌交换落到 `/`，所以地址栏会短暂出现 `?token=…`（DSH 自己的机制）。
- HTTPS 不由本插件提供，用隧道或反代；回调地址会自动按请求的 `Host` + `X-Forwarded-Proto` 推导。
- 日志里的 `from <ip> via <socket>` 前半段取 `X-Forwarded-For` 首跳，**未经校验**：能直连到本端口的请求方可以伪造这个字段。它是审计信息，不参与任何放行判断。

## 维护

```bash
cd ~/.dsh/plugins/dsh-feishu-auth && node --test   # 36 个用例
```

零运行时依赖（只用 node 内置模块）。`lib/` 七个文件：`index.js` 挂载、启动自检与 harness 入口解析（`ctx.inject(['connection'])`）、`gate.js` 拦截、OAuth 端点与 harness 交接、`feishu.js` 飞书接口、`session.js` 签名 Cookie、`config.js` 配置与 Cookie 名、`pages.js` 提示页、`urls.js` 地址推导与开放重定向防护。
