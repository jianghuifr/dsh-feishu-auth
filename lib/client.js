/**
 * Browser half of the gate: one「退出登录」entry in the settings panel.
 *
 * The server half owns `/feishu-auth/logout`, which clears this gate's session
 * cookie AND the harness's own `dsh-auth-*`, so this half only has to put a link
 * to it in front of the user.
 *
 * Two contracts come from dsh, and both are load-bearing:
 *
 * - The file is a **client bundle**: it registers a factory through
 *   `window.__ModuleLoader__.load({ id, factory })` and does nothing else at the
 *   top level. `@deepseek-ai/dsh-client-modules` serves it at
 *   `/plugins/@jianghuifr/dsh-feishu-auth/client.js` (it discovers any package declaring
 *   `dsh.client` plus `exports["./client"]`, not just `@deepseek-ai/*`), and the
 *   runtime rejects a bundle that requests an external before the module system
 *   exists. Hence: no top-level `require`, no top-level side effects.
 * - The seat is the slot API's, not ours: `ctx.slots.inject(name, …)` waits for
 *   the slot to exist — `settings.action` is declared by the settings panel
 *   entry, so it only exists while that panel is mounted — and `register` adds
 *   an entry beside the shipped ones (`id` of our own, so nothing is replaced).
 *
 * Styles stay inline: a client bundle may inject CSS from inside its factory
 * closure, but one button does not justify a stylesheet.
 * @module @jianghuifr/dsh-feishu-auth/client
 */

window.__ModuleLoader__.load({
  id: '@jianghuifr/dsh-feishu-auth',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    /** The seat: content-column header actions, rendered before the Close button. */
    const SLOT = 'settings.action';
    /** This entry's id inside that slot — ours, so the shipped entries stay. */
    const ENTRY_ID = 'feishu-logout';
    /** Where the server half signs this browser out. */
    const LOGOUT_PATH = '/feishu-auth/logout';

    /** Resting and hover looks, kept close to the shipped header actions. */
    const REST = {
      color: 'var(--dsw-alias-label-secondary, #6b6b70)',
      background: 'transparent',
    };
    const HOVER = {
      color: 'var(--dsw-alias-label-primary, #1d1d1f)',
      background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.12))',
    };

    /**
     * The entry itself: a plain link, so a middle-click or a reload-free
     * navigation both reach the server half.
     * @returns the anchor element.
     */
    function LogoutAction() {
      const [state, setState] = React.useState(REST);
      return React.createElement(
        'a',
        {
          href: LOGOUT_PATH,
          title: '清掉这台浏览器上的登录凭据',
          style: {
            ...state,
            display: 'inline-flex',
            alignItems: 'center',
            height: '28px',
            padding: '0 10px',
            border: '0',
            borderRadius: '8px',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: '18px',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            transition: 'color .12s, background .12s',
          },
          onMouseEnter: () => setState(HOVER),
          onMouseLeave: () => setState(REST),
        },
        '退出登录',
      );
    }

    const inject = ['slots'];

    /**
     * Register the entry, waiting for the settings panel to declare the slot.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 100, label: '退出登录' }, LogoutAction),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
