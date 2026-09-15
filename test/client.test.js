import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Minimal React stand-in: enough to build and read one element tree. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [initial, () => {}];
  },
};

/**
 * Evaluate the client bundle the way the browser module loader does: the file
 * registers its factory on the page global, and the factory then receives a
 * `require` for its externals.
 *
 * @param options - the externals to serve, and whether the file may `require` at
 * the top level (it may not: the real loader throws there).
 * @returns the registrations the bundle made, plus the materialized exports.
 */
function loadBundle({ topLevelRequire = false } = {}) {
  const registrations = [];
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
  let topLevel = true;
  const require = (specifier) => {
    if (topLevel && topLevelRequire !== true) {
      throw new Error(`client bundle requested external "${specifier}" before the module system existed`);
    }
    if (specifier === 'react') return React;
    throw new Error(`unexpected external: ${specifier}`);
  };
  new Function('window', 'require', SOURCE)(window, require);
  topLevel = false;
  const registration = registrations[0];
  return {
    registrations,
    exports: registration === undefined ? undefined : registration.factory(require),
  };
}

test('the bundle registers exactly one factory under the package name', () => {
  const { registrations } = loadBundle();
  assert.equal(registrations.length, 1, 'one bundle, one registration');
  assert.equal(registrations[0].id, '@jianghuifr/dsh-feishu-auth', 'the id is the package name the server serves it under');
  assert.equal(typeof registrations[0].factory, 'function');
});

test('the bundle keeps the purity gate: no external before the module system exists', () => {
  // The real loader throws on a top-level require; the bundle must survive it.
  const { registrations } = loadBundle({ topLevelRequire: true });
  assert.equal(registrations.length, 1);
});

test('the factory injects the slots service and nothing else', () => {
  const { exports } = loadBundle();
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(typeof exports.apply, 'function');
});

test('apply waits for the settings action seat and adds our own entry to it', () => {
  const { exports } = loadBundle();
  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject(name, contribute) {
        injected.push(name);
        contribute();
      },
      register(options, component) {
        registered.push({ options, component });
      },
    },
  };
  exports.apply(ctx);

  assert.deepEqual(injected, ['settings.action'], 'the seat is the settings header actions, waited for');
  assert.equal(registered.length, 1);
  const { options } = registered[0];
  assert.equal(options.name, 'settings.action');
  assert.equal(options.id, 'feishu-logout', 'our own id, so the shipped entries are not replaced');
  assert.equal(options.label, '退出登录');
  assert.equal(typeof registered[0].component, 'function');
});

test('the entry is a plain link to the gate logout endpoint', () => {
  const { exports } = loadBundle();
  let component;
  exports.apply({
    slots: {
      inject: (_name, contribute) => contribute(),
      register: (_options, registered) => {
        component = registered;
      },
    },
  });
  const element = component();
  assert.equal(element.type, 'a', 'a link, so a reload-free navigation reaches the server half');
  assert.equal(element.props.href, '/feishu-auth/logout');
  assert.deepEqual(element.children, ['退出登录']);
});
