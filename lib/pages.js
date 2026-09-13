/**
 * Self-contained HTML for the gate's terminal states: denied, error, logged
 * out, and not-configured. Everything is inline, so these pages never depend
 * on the assets the gate protects.
 * @module dsh-feishu-auth/pages
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
