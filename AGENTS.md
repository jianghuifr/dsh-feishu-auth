# AGENTS.md — dsh-feishu-auth

给在本仓库里干活的 agent 和维护者。人类读者先看 [README.md](README.md)；要改内部机制先看 [docs/architecture.md](docs/architecture.md)。

## 这是什么

DSH（DeepSeek Harness）Web 界面的飞书 OAuth 登录网关。一个 Cordis 插件：替换运行中 `webServer` 服务的 `match(pathname)` 分发点，除插件自身端点外，对**所有**请求要求一个 HMAC 签名的会话 Cookie。挂在哪个地址就保护哪个地址。

两条不变量，任何改动都不得破坏：

- **故障关闭（fail closed）**：拿不到凭证、配置矛盾、挂不上分发点时，拒绝一切访问（503 / 拒绝启动），绝不「静默放过」。
- **故障响亮（fail loud）**：挂载、拒绝、登录、自检失败都要出现在 `dsh web` 终端；自检失败不许当成成功。

## 仓库地图

| 路径 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：配置分析、会话密钥文件、挂载、启动自检、harness 入口解析（`ctx.inject(['connection'])`） |
| `lib/gate.js` | 网关引擎：分发拦截与层标记、OAuth 端点、拒绝策略、harness 两段式交接 |
| `lib/feishu.js` | 飞书接口：授权 URL、换 user_access_token、读用户信息 |
| `lib/session.js` | HMAC 签名 Cookie（会话 / state）、密钥文件读写 |
| `lib/client.js` | 浏览器半边：设置面板「退出登录」入口，注册进插槽 `settings.action` |
| `lib/config.js` | 配置解析与 Cookie 名、TTL 常量 |
| `lib/urls.js` | Host 规范化、回调地址推导、`next` 开放重定向防护、导航请求判定 |
| `lib/pages.js` | 提示页（拒绝 / 错误 / 未就绪 / 已登出），全部内联样式 |
| `enable.patch.yml` / `disable.patch.yml` | 启用 / 停用 overlay |
| `test/` | `node --test`，零依赖，替身自建 |
| `docs/architecture.md` / `docs/release.md` | 内部设计（拦截层身份、两段式交接）与发版流程（staged + trusted publishing） |

零运行时依赖：只用 node 内置模块，所以在没 `pnpm install` 过的 profile 里也能直接引用。

## 安装与激活

仓库放在 `~/.dsh/plugins/dsh-feishu-auth/`。在 `~/.dsh/profiles/web/cordis.patch.yml` 里插入（`name` 相对 profile 目录解析）：

```yaml
- insert:
    - id: feishu-auth
      name: ../../plugins/dsh-feishu-auth/lib/index.js
      config:
        appId: !!js process.env.FEISHU_APP_ID
        appSecret: !!js process.env.FEISHU_APP_SECRET
        allowedUsers: []
        sessionMaxAgeDays: 14
```

凭证放 `~/.dsh/.env`（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`，权限 600）；`DSH_` 开头的变量不能写进 `.env`，启动器会直接报错。

- **启用/停用 overlay**：`--patch <本目录>/enable.patch.yml` 或 `disable.patch.yml`，写在 `--profile web` 一侧（`dsh web` 别名形式不接受 `--patch`）。
- **不要同时**用 profile 行和 `dsh plugin --profile web add` 安装同一个 id。

## 运行与验证

```bash
cd ~/.dsh/plugins/dsh-feishu-auth && node --test    # 单元用例
```

改完代码要重启 `dsh web` 才生效（插件模块不热重载）。部署验收清单：

| 检查 | 期望 |
| --- | --- |
| 启动日志 | `飞书登录已挂载 …` + `网关自检通过（未登录 → HTTP 401，已登录 → HTTP 404）`，无 `[error]` |
| 未登录访问（浏览器式请求） | `302 → /feishu-auth/login?next=…`；`/api` 无 cookie 时是 `401` JSON |
| 完整登录交接 | `GET /` → harness 回 401 时给 **200 同站重进页**（自动跳回 `/`）→ 再访问 `/` 得 `200` 真实应用页；harness 不回 401 时走 `303 /?token=…` → 下发 `dsh-auth-*` → 再访问 `/` 得 `200` |
| 停用验证 | 探针应从 `302`（网关在岗）变成 `401`（harness 自己的门）——这是确认层真的被摘掉的唯一可靠信号 |
| `/feishu-auth/status` | `{"gate":"enforce","authenticated":…}` |
| 设置页入口 | 打开设置面板：头部「关闭」左边出现「退出登录」；点击后落到「已退出登录」页，浏览器里本插件与 harness 的 Cookie 都清空 |

## 配置项的生效语义

| 改动 | 生效方式 |
| --- | --- |
| `allowedUsers`、`sessionMaxAgeDays` | 热生效：保存后日志立刻出现新的「飞书登录已挂载」行 |
| `appId` / `appSecret`（`~/.dsh/.env`） | 只在启动时读取，**必须重启** |
| 加 / 删 / 停用整行（`disabled: true`） | 结构变更不热生效，**必须重启**（实测挂载后 45 秒仍未摘除） |

名单只在登录回调那一刻判定，所以改名单不会踢掉已登录会话。

## 运维速查

日志同时进 `dsh web` 终端和内存缓冲，格式：

```
feishu-auth[info] 飞书登录已挂载  prefix=/feishu-auth  允许范围=…  会话有效期=14 天
feishu-auth[info] 网关自检通过（未登录 → HTTP 401，已登录 → HTTP 404）
feishu-auth[warn] 拒绝未认证请求 GET / host=… from <ip> via <socket> (no-cookie)
feishu-auth[info] 登录成功 name=… open_id=… tenant=… from …
feishu-auth[error] 拿不到 harness 的入口地址（connection 服务不可达）…
```

| 现象 | 处理 |
| --- | --- |
| 所有请求 503 | 凭证不在进程环境里：确认 `~/.dsh/.env` 后重启 |
| 页面打不开（0.1.3 之前会停在 harness 的 401 页） | 网关自己收尾：先给同站重进页、再换新凭据，两轮都不行才给「还差一步」页并打 warn。若日志里完全没有恢复行、只有 `[error]` 说拿不到入口地址 → 检查 `ctx.inject(['connection'])` 是否仍被 dsh 支持 |
| 飞书报 `redirect_uri unmatch` | 回调地址没登记/不一致；临时隧道换域名后必须补登记 |
| 飞书报 `20010` | 账号不在应用可用范围，或应用版本未发布 |
| 想立刻放行 | `disable.patch.yml` 启动一次，或给该行加 `disabled: true` 后重启 |

会话自述与登出：`GET /feishu-auth/status`、`GET /feishu-auth/logout`。

## 开发约束

- **绝不用身份比较判断服务成员。** `ctx.webServer` 是 Cordis traceable 服务，成员读取每次都返回新的包装 Proxy：`server.match === 你的函数` 恒为 false。识别自己的层只能靠符号标记，解包靠 `Symbol.for('cordis.original')`。详见架构文档。
- **挂载/卸载必须幂等。** 热重载时新层可能先于旧层的 disposer 挂上：只允许最新层卸载，发现遗留层要复用它的原始实现而不是往上叠。
- **新增行为要补用例**，并确认「旧实现下该用例会红」——否则它没锁住任何东西。
- **不注入 DOM、不改 harness 的客户端资产**：要出现在界面上只走 dsh 的插槽（`lib/client.js`，见架构文档「客户端半边」），不要往页面里塞元素。
- **浏览器半边必须保持「注册工厂」形态**：`lib/client.js` 顶层只允许 `window.__ModuleLoader__.load({ id, factory })`；`require` 与一切副作用都必须进 factory，否则运行时直接抛。
- **提示页只用内联样式**，不能依赖被自己保护的静态资源。
- 配置解析永不抛错：除凭证外的问题降级为默认值并记录；凭证缺失走故障关闭。

## 改动流程

1. 改 `lib/`，跑 `node --test`。
2. 在本机 `dsh web` 实测：启动自检 + 未登录 302 + 完整交接 200；涉及卸载/重载的改动要额外验「停用 → 401、再启用 → 302」。
3. 提交并推送 `git push origin main`（仓库 `jianghuifr/dsh-feishu-auth`，带 `dsh-plugin` topic）。
4. 影响用户可见行为或配置语义的改动，同步更新 [README.md](README.md) 和 [AGENTS.md](AGENTS.md)（本文）以及架构文档中的对应事实。
5. 发版：`npm version patch` → 推 tag → CI 走 `npm stage publish`（OIDC，无 token）→ 在 npmjs 批准后上线。详见 [docs/release.md](docs/release.md)。
6. 合并改动 `.github/workflows/` 的 PR 时，执行合并的凭据必须带 `workflow` scope（GitHub 对 OAuth App / PAT 的硬限制，与改动内容无关）：用 gh CLI 就先 `gh auth refresh -s workflow` 补授权，或改用网页合并，或本地应用同样改动后直接推 `main`。

## 与 dsh 版本的耦合点

升级 dsh 后优先复核这几处，任何一处变了都要同步适配：

| 依赖 | 用途 | 失效表现 |
| --- | --- | --- |
| `webServer.match(pathname)` 分发点 | 唯一的拦截缝隙 | 插件**拒绝启动**并报错（不会静默放过） |
| `ctx.inject(['connection'])` | 取 harness 入口地址（两段式交接） | 日志 error；只剩同站重进这一步可救，跨站链那类场景会落到「还差一步」页 |
| `dsh-auth-<authority>` Cookie 前缀 | 登出时清掉 harness 自己的 Cookie | 登出后可能被 harness 直接放回 |
| `/?token=<launch token>` 兑换约定 | 交接第二段 | 同上 |
| `dsh.client` + `exports["./client"]` 契约 | 浏览器半边的发现与托管（`/plugins/??<id>/client.js`） | 设置页里没有「退出登录」入口，`/plugins/…` 404 |
| 插槽名 `settings.action`（`ctx.slots`） | 入口在设置面板里的位置 | 入口不出现；需换槽名并核对 `settings.*` 插槽目录 |

另见架构文档「已知边界与风险」。
