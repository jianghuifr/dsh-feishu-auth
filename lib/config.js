/**
 * Plugin config: four flat keys, and the fail-closed analysis the entry runs.
 *
 * The validator never throws. A config that cannot authenticate anyone still
 * installs the gate, and the gate then refuses every request with an
 * explanation instead of leaving the page exposed.
 * @module @jianghuifr/dsh-feishu-auth/config
 */

/** Cookie carrying the signed browser session. */
export const SESSION_COOKIE = 'dsh-feishu-session';
/** Cookie carrying the one-shot OAuth state. */
export const STATE_COOKIE = 'dsh-feishu-state';
/** Marker bounding the harness handoff to one attempt per exchange. */
export const HANDOFF_COOKIE = 'dsh-feishu-handoff';
/** OAuth state lifetime: enough for a slow consent screen, no longer. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** How long the handoff marker lives. */
export const HANDOFF_TTL_SECONDS = 20;
/** Every endpoint this plugin owns lives under this prefix. */
export const PATH_PREFIX = '/feishu-auth';
/** Browser-session lifetime in days. */
export const DEFAULT_SESSION_MAX_AGE_DAYS = 14;

function readNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolve raw plugin config into the shape the gate consumes.
 *
 * Credentials fall back to `FEISHU_APP_ID` / `FEISHU_APP_SECRET`, which is how
 * this deployment keeps the secret in `$DSH_HOME/.env` rather than in a config
 * file. A malformed `allowedUsers` is fatal on purpose: silently dropping it
 * would widen access to every user who can complete the Feishu login.
 * @param raw - the config object the loader passed (or nothing).
 * @returns `{ config, fatal }` — `fatal` forces the gate's fail-closed mode.
 */
export function analyzeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fatal = [];

  const appId = readNonEmptyString(source.appId) ?? readNonEmptyString(process.env.FEISHU_APP_ID) ?? '';
  const appSecret = readNonEmptyString(source.appSecret) ?? readNonEmptyString(process.env.FEISHU_APP_SECRET) ?? '';
  if (appId === '') fatal.push('未配置 appId，也没有环境变量 FEISHU_APP_ID');
  if (appSecret === '') fatal.push('未配置 appSecret，也没有环境变量 FEISHU_APP_SECRET');

  let allowedUsers = [];
  if (source.allowedUsers !== undefined && source.allowedUsers !== null) {
    const entries = Array.isArray(source.allowedUsers) ? source.allowedUsers : undefined;
    const cleaned = entries?.map(readNonEmptyString).filter((value) => value !== undefined);
    if (cleaned === undefined || cleaned.length !== entries.length) {
      fatal.push('allowedUsers 必须是字符串数组（例如 [ou_xxx, ou_yyy]）');
    } else {
      allowedUsers = [...new Set(cleaned)];
    }
  }

  const rawDays = source.sessionMaxAgeDays;
  const sessionMaxAgeDays =
    Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 365 ? rawDays : DEFAULT_SESSION_MAX_AGE_DAYS;

  return { config: { appId, appSecret, allowedUsers, sessionMaxAgeDays }, fatal };
}

/** The standard-schema validator cordis calls before the plugin starts. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-feishu-auth',
    /**
     * Validate and normalize plugin config.
     * @param value - the raw config from the patch row.
     * @returns the normalized config as the schema's value.
     */
    validate(value) {
      return { value: analyzeConfig(value).config };
    },
  },
};
