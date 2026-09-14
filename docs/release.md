# 分发、CI 与发版

[README](../README.md) 讲怎么用，[AGENTS.md](../AGENTS.md) 讲怎么改，[架构](architecture.md) 讲内部设计。本文讲这个包怎么分发出去、CI 跑什么、版本怎么发。

## 分发形态

| 形态 | 用途 | 装载方式 |
| --- | --- | --- |
| npm 包（组合包） | 常规安装 | `dsh plugin --profile <name> add dsh-feishu-auth` |
| tarball | 离线 / 内网 | `npm pack` 后 `dsh plugin --profile <name> add ./dsh-feishu-auth-0.1.0.tgz` |
| 本地源码 | 开发 | 见 [AGENTS.md 的安装与激活](../AGENTS.md#安装与激活) |

npm 路径靠 `package.json` 的 `dsh.bundle.patch` 声明自己是组合包，`cordis.patch.yml` 就是它应用的那一层——插件行按**包名**引用，Node 的模块解析才找得到已安装的代码。层语义：后应用的层按 `id` 覆盖前面的行，且 patch 替换整行 `config` 而不是深合并，所以用户 profile 自己的 `cordis.patch.yml` 能覆盖本包给的默认值。

`lib/` 是纯 JS，发布包直接带源码，所以从 git 安装也不需要 `prepare` 构建，更没有安装时执行脚本的授权问题。

## 开发与校验

```bash
npm ci               # 只装 devDependencies（eslint）；运行时零依赖
npm run lint
npm test             # node --test，50 个用例
npm run verify       # lint + test —— CI 与 prepublishOnly 跑的就是它
npm pack --dry-run   # 检查发布产物内容（16 个文件）
```

`lib/client.js`（浏览器半边）是**手写**的 loader 包装，不是构建产物：文件顶层只允许 `window.__ModuleLoader__.load({ id, factory })`，任何顶层 `require` 或副作用都会被运行时拒绝。改动它的规范见 [docs/architecture.md 的「客户端半边」](architecture.md#客户端半边)。

## CI

`.github/workflows/ci.yml`，在 push 到 `main`、PR、手动触发时跑：

| job | 内容 |
| --- | --- |
| `lint` | `npm ci` + `npm run lint` |
| `test` | node 22 / 24 矩阵 + `npm test` |
| `package` | `npm pack --dry-run` + `npm stage publish --dry-run`（与发版同一条命令，凭据无关） |

## 发版：staged publishing + trusted publishing

发布走 npm 的**暂存**机制：CI 把版本放进 stage 队列（非公开、不可安装），维护者再用 2FA 批准，版本才上线。这样 CI 里不需要任何长期 token——泄露的 token 也发不出版——代价是每次发版要人工点一次。

```bash
npm version patch      # 或 minor / major；改 package.json 并生成 vX.Y.Z tag
git push --follow-tags
```

`.github/workflows/release.yml` 依次做四件事：校验 tag 与 `package.json` 版本一致 → `npm run verify` → 查 npm 上是否已有该版本（有则跳过暂存）→ `npm stage publish --access public` → `gh release create --generate-notes`。流水线最后会把「待批准」写进该次运行的 Summary。

随后批准上线，二选一：

- 网页：npmjs.com → 你的账号 → **Staged Packages** → 选中版本 → Approve（提示 2FA）
- CLI：`npm stage list` 拿 stage id → `npm stage approve <stage-id>`（需 2FA；npm 会要求到 `https://www.npmjs.com/auth/cli/…` 做一次浏览器认证，链接一次性且约几分钟过期，过期就重跑命令拿新链接）

批准前可以验货：`npm stage download <stage-id>` 把 tarball 拉下来看，`npm stage reject <stage-id>` 丢弃。

### 前提

| 前提 | 说明 |
| --- | --- |
| 账号已开 2FA | staged publishing 的硬要求；`npm stage publish` 不要 2FA，approve 必须过 |
| 包已存在于 registry | **stage 不支持全新包**，首次发布必须手工 `npm publish` |
| trusted publisher 已配置 | npmjs.com 该包 → Settings → Trusted Publishing → 添加 GitHub Actions 发布者：`jianghuifr` / `dsh-feishu-auth` / workflow `release.yml`，权限限制为 **stage-only** |

配成 stage-only 后，该 workflow 发起的 `npm publish` 会被 registry 拒绝，只有 `npm stage publish` 被接受。

### 首次发布（已完成：0.1.0 于 2026-09-13 手工发布）

`stage` 不支持全新包，所以建包这一次必须手工做，之后一律走上面的 staged 流程。

```bash
# 在你自己的仓库副本里执行
npm login --registry https://registry.npmjs.org
npm publish --access public --registry https://registry.npmjs.org
```

- 若你的 npm 默认源是镜像（国内常见配置），必须显式带 `--registry https://registry.npmjs.org`，否则会发到镜像上。
- 手工发布的 0.1.0 不带 provenance（provenance 需要 CI 的 OIDC）；从 0.1.1 起走流水线自动带。

## 版本号与 npm CLI

`npm stage` 需要 npm CLI ≥ 11.15：本地版本不够时用 `npx npm@latest stage ...`。`ci.yml` 与 `release.yml` 里都显式 `npm install -g npm@latest`，不受 runner 自带版本影响。

包名 `dsh-feishu-auth` 已发布（`0.1.0`，2026-09-13；此前查官方 registry 为 404 即未占用）。此后发版一律走 staged 流程，账号需保持 2FA 开启。

## 依赖维护

`.github/dependabot.yml` 每周检查 npm 与 GitHub Actions 依赖并开 PR；合并前跑 `npm run verify`。运行时零依赖，所以 dependabot 只碰 devDependencies 与 action 版本。
