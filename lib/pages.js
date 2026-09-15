/**
 * Self-contained HTML for the gate's terminal states: denied, error, logged
 * out, and not-configured. Everything is inline, so these pages never depend
 * on the assets the gate protects.
 * @module @jianghuifr/dsh-feishu-auth/pages
 */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 32px 20px; background: #f5f5f7; color: #1d1d1f;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) { body { background: #16171a; color: #e8e8ea; } }
  main {
    width: 100%; max-width: 520px; background: #fff; border-radius: 14px; padding: 32px;
    box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.08);
  }
  @media (prefers-color-scheme: dark) { main { background: #202124; box-shadow: 0 1px 2px rgba(0,0,0,.4); } }
  .badge { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #8a8a8e; margin-bottom: 10px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; word-break: break-all; }
  dl { margin: 0 0 16px; padding: 14px 16px; border-radius: 10px; background: rgba(127,127,127,.10); }
  dt { font-size: 12px; color: #8a8a8e; margin-top: 8px; }
  dt:first-child { margin-top: 0; }
  dd { margin: 2px 0 0; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
  a.button { display: inline-block; padding: 9px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; background: #1a73e8; color: #fff; }
  .tone-error a.button { background: #d93025; }
  .note { font-size: 13px; color: #8a8a8e; }
`;

/**
 * Escape text placed into HTML text or a quoted attribute.
 * @param value - untrusted text.
 * @returns escaped text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPage({ title, heading, body, tone = 'neutral' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="tone-${escapeHtml(tone)}">
<div class="badge">DSH · 飞书登录</div>
<h1>${escapeHtml(heading)}</h1>
${body}
</main>
</body>
</html>
`;
}

function retry(loginPath, label = '重新登录') {
  return `<div class="actions"><a class="button" href="${escapeHtml(loginPath)}">${escapeHtml(label)}</a></div>`;
}

function facts(rows) {
  const items = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd class="mono">${escapeHtml(value)}</dd>`)
    .join('');
  return items === '' ? '' : `<dl>${items}</dl>`;
}

/**
 * Quote a value for a `<script>` context, so a URL built from the request can
 * never close the tag or start a new statement.
 * @param value - untrusted text.
 * @returns a JavaScript string literal.
 */
function jsString(value) {
  return JSON.stringify(String(value ?? '')).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

/**
 * The page that re-enters the harness from this origin.
 *
 * The harness mints `dsh-auth-<authority>` with `SameSite=Strict`. A browser
 * that arrives through a cross-site chain — the Feishu OAuth redirect is one,
 * and the redirects that follow it stay in that chain — therefore does not send
 * that cookie on the later hops of the same chain, and the harness answers its
 * auth wall although the cookie is already stored. A navigation started from a
 * document on this origin is same-site, so one extra hop carries the cookie.
 * @param options - the path to re-enter.
 * @returns the HTML document.
 */
export function renderEntering({ target }) {
  const body = `
<p>已通过飞书验证，正在进入…</p>
<p class="note">如果没有自动跳转，<a href="${escapeHtml(target)}">点这里继续</a>。</p>
<script>location.replace(${jsString(target)});</script>`;
  return renderPage({ title: '正在进入 · DSH', heading: '正在进入 DSH', body });
}

/**
 * The page shown when the recovery ladder is exhausted: the browser stored
 * neither this gate's cookie nor the harness's, so no redirect can help and the
 * harness's own wall (which names an internal URL the operator would have to
 * dig out) is replaced with an actionable page.
 * @param options - the path to retry and the login path.
 * @returns the HTML document.
 */
export function renderRecoveryStuck({ target, loginPath }) {
  const body = `
<p>这台浏览器没有把 DSH 自己的凭据交给服务器，自动恢复已经试过两轮。</p>
<p class="note">常见原因：无痕/隐私模式、拦下本站 Cookie 的拦截扩展、或浏览器把这次访问当成第三方上下文。换个普通窗口通常即可。</p>
<div class="actions">
<a class="button" href="${escapeHtml(target)}">再试一次</a>
<a class="button" href="${escapeHtml(loginPath)}">重新登录</a>
</div>`;
  return renderPage({ title: '还差一步 · DSH', heading: '还差一步', body, tone: 'error' });
}

/**
 * The page an authenticated-but-unauthorized account sees: its own identifiers
 * and nothing about anyone else, so the operator can allowlist the right value.
 * @param options - the signed-in account, the reason, and the login path.
 * @returns the HTML document.
 */
export function renderDenied({ name, openId, reason, loginPath }) {
  const body = `
<p>飞书已完成身份认证，但这个账号没有访问这台 DSH 的权限。</p>
<p><b>原因：</b>${escapeHtml(reason)}</p>
${facts([['姓名', name], ['open_id', openId]])}
<p class="note">把上面的 open_id 加入配置的 <code>allowedUsers</code>（或把该成员加入飞书应用的可用范围），然后重启 <code>dsh web</code>。</p>
${retry(loginPath, '换一个飞书账号登录')}`;
  return renderPage({ title: '无权访问 · DSH', heading: '这个账号没有访问权限', body, tone: 'error' });
}

/**
 * A terminal error page for a failed or expired login attempt.
 * @param options - heading, message, optional detail, and the login path.
 * @returns the HTML document.
 */
export function renderError({ heading, message, detail, loginPath }) {
  const body = `
<p>${escapeHtml(message)}</p>
${detail === undefined || detail === '' ? '' : `<p class="note mono">${escapeHtml(detail)}</p>`}
${retry(loginPath)}`;
  return renderPage({ title: '登录失败 · DSH', heading, body, tone: 'error' });
}

/**
 * The page shown after an explicit logout.
 * @param options - the login path.
 * @returns the HTML document.
 */
export function renderLoggedOut({ loginPath }) {
  return renderPage({
    title: '已退出 · DSH',
    heading: '已退出登录',
    body: `<p>本机浏览器上的访问凭据已清除。</p>${retry(loginPath, '使用飞书登录')}`,
  });
}

/**
 * The fail-closed page: the gate is mounted but cannot authenticate anyone, so
 * the page stays shut until configuration is fixed.
 * @param options - the configuration problem.
 * @returns the HTML document.
 */
export function renderMisconfigured({ problem }) {
  const body = `
<p>飞书登录未配置完成，因此<b>所有访问都被拒绝</b>（包括你自己的）。</p>
<p><b>问题：</b>${escapeHtml(problem)}</p>
<p class="note">在终端修好配置后重启 <code>dsh web</code> 即可恢复。急着重启：见 README「停用」。</p>`;
  return renderPage({ title: '未就绪 · DSH', heading: '飞书登录未就绪', body, tone: 'error' });
}
