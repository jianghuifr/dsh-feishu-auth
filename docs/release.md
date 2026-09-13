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
npm test             # node --test，39 个用例
npm run verify       # lint + test —— CI 与 prepublishOnly 跑的就是它
npm pack --dry-run   # 检查发布产物内容（14 个文件）
```

## CI

`.github/workflows/ci.yml`，在 push 到 `main`、PR、手动触发时跑：

| job | 内容 |
| --- | --- |
| `lint` | `npm ci` + `npm run lint` |
| `test` | node 22 / 24 矩阵 + `npm test` |
| `package` | `npm pack --dry-run` + `npm publish --dry-run`（发布产物与可发布性） |

## 发版

`.github/workflows/release.yml`，由 **tag 推送**触发。流程：校验 tag 与 `package.json` 版本一致 → `npm run verify` → 查 npm 上是否已有该版本 → `npm publish --provenance --access public` → `gh release create --generate-notes`。

```bash
npm version patch      # 或 minor / major；同时改 package.json 并生成 vX.Y.Z tag
git push --follow-tags
```

- 版本已存在于 npm 时**跳过发布**但仍更新 Release 说明，重复推 tag 不会把流程炸掉。
- 发布失败可在 Actions 页面直接 Re-run 该 job。
- `--provenance` 需要 `id-token: write`（workflow 里已声明），npm 会为产物附上 attestation。

## 首次发布要配的凭据

两条路，选一条：

1. **npm Trusted Publishing（推荐，无需长期 token）** — 在 npmjs.com 该包的 Publishing 设置里添加 GitHub Actions 发布者（仓库 `jianghuifr/dsh-feishu-auth` + workflow 文件名 `release.yml`）。配好后可以从 `release.yml` 里删掉 `NODE_AUTH_TOKEN`，鉴权走 OIDC。
2. **NPM_TOKEN** — npmjs.com 生成 Automation token，在 GitHub 仓库 Settings → Secrets and variables → Actions 里新建 secret `NPM_TOKEN`。`release.yml` 已按这个名字引用。

包名 `dsh-feishu-auth` 未被占用（2026-09-13 查 registry 返回 404）。首次发布前确认 npm 账号已开 2FA。

## 依赖维护

`.github/dependabot.yml` 每周检查 npm 与 GitHub Actions 依赖并开 PR；合并前跑 `npm run verify`。运行时零依赖，所以 dependabot 只碰 devDependencies 与 action 版本。
