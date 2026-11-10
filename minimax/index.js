/**
 * MiniMax Code 订阅接入（vendored）。
 *
 * 上游：https://github.com/VICqiufeeng/dsh-minimax-connect —— MIT License,
 * Copyright (c) 2026 VICqiufeeng。见包根目录 THIRD_PARTY_NOTICES.md。
 *
 * 合并进 dsh-mm-models 时做的改动（仅此几处）：
 *   - 插件名 minimax-connect -> mm-minimax（行 id 与设置命名空间同值）；
 *   - HTTP 路由前缀 /plugins/dsh-minimax-connect/* -> /plugins/dsh-mm-models/minimax/*；
 *   - 其余逻辑（凭据读取/续期/模型目录/积分/签到/订阅额度）与上游 0.3.0 一致，
 *     另含本机对签到按钮的两处修正（见 minimax/SIGNIN-FIX.md）。
 */
/**
 * DSH Connect MiniMax — host half.
 *
 * Turns the MiniMax Code (Mavis) desktop subscription already signed in on this
 * machine into a DSH model provider. The account is points-based, so this half
 * also exposes the points balance, the 7-day check-in panel, and a claim action.
 *
 * Verified against the live service (all measured, not guessed):
 *   POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages   -> Anthropic
 *        Messages protocol; 200 with content[]/usage{input_tokens,...}.
 *        `GET .../models` answers 503 `direct_route_not_configured`, so the
 *        model roster is read from the local config.yaml instead.
 *   GET  https://agent.minimax.cn/minimax-cloud/api/v1/credit/details
 *        -> {details:[{granted_amount,remaining_amount,consumed_amount,...}]}
 *   GET  .../signin/status?timezone_id=Asia/Shanghai   (the param is REQUIRED;
 *        without it the API answers 1406010011 "invalid timezone_id")
 *   POST .../signin/claim  body {}  -> the claim; sending an empty body is what
 *        the first-party client does (read out of its app.asar).
 *
 * @module mm-minimax
 */

import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

/**
 * Peers are ESM-only and use import-only `exports` maps, so `require()` and
 * `require.resolve()` both fail on them (ERR_REQUIRE_ESM /
 * ERR_PACKAGE_PATH_NOT_EXPORTED). They are therefore loaded with a bare
 * `import()`, which resolves against this file's own location — the plugin
 * directory — and that is the same chain the host uses.
 *
 * A host missing one of them degrades to "provider not registered" with a
 * reason instead of failing at module load.
 */
const PEERS = {
  piAi: ['@earendil-works/pi-ai', 'createProvider'],
  anthropic: ['@earendil-works/pi-ai/api/anthropic-messages.lazy', 'anthropicMessagesApi'],
  adapter: ['@deepseek-ai/dsh-llm-pi-ai', 'PiAiAdapter'],
  /**
   * `resolveImageAttachmentAccess` — the host-side bridge from an attachment
   * reference to a readable host path. Required from the 0.2 line on: the
   * adapter's `resolveImageAccess` hook is what turns a request image into a
   * file the transport can read, and without it every image request fails with
   * `pi-ai image input requires the durable attachment service`.
   */
  llm: ['@deepseek-ai/dsh-llm', 'resolveImageAttachmentAccess'],
};

let peersPromise;
function loadPeers() {
  if (peersPromise === undefined) {
    peersPromise = (async () => {
      const out = { errors: [] };
      for (const [key, [spec, exportName]] of Object.entries(PEERS)) {
        try {
          const mod = await import(spec);
          out[key] = mod?.[exportName];
          if (out[key] === undefined) out.errors.push(`${spec} has no export ${exportName}`);
        } catch (error) {
          out[key] = undefined;
          out.errors.push(`${spec}: ${error.code ?? String(error.message).split('\n')[0]}`);
        }
      }
      return out;
    })();
  }
  return peersPromise;
}

export const name = 'mm-minimax';

/**
 * The model registry must exist before a provider can register, so `llm` is a
 * hard dependency: without it `ctx.llm` is undefined and the provider never
 * reaches the model picker.
 */
export const inject = ['llm'];

/**
 * The Anthropic SDK posts to `<baseUrl>/v1/messages`, so the base is the Mavis
 * root WITHOUT the trailing `/v1` — measured: `/mavis/api/v1/llm` yields that
 * exact path and returns 200, while `/mavis/api/v1/llm/v1` answers 503
 * `direct_route_not_configured`. The read-only cloud routes below DO carry
 * `/v1`, so the two bases are deliberately different.
 */
const DEFAULT_BASE = 'https://agent.minimax.cn/mavis/api/v1/llm';
const CLOUD_BASE = 'https://agent.minimax.cn/minimax-cloud/api/v1';
/**
 * The commerce namespace the desktop client itself uses.
 *
 * Measured from the shipped MiniMax Code bundle: the plan/credit state lives
 * under `/matrix/api/v1/...`, a sibling of `/minimax-cloud/api/v1` on the same
 * host. It is derived from the cloud base by default so a CN -> IO switch keeps
 * both in step.
 */
const MATRIX_BASE = 'https://agent.minimax.cn/matrix/api/v1';
const PROVIDER_ID = 'minimax';

/**
 * The commerce base, derived from the cloud base unless one is configured.
 *
 * `https://agent.minimax.cn/minimax-cloud/api/v1` -> `https://agent.minimax.cn/matrix/api/v1`.
 */
function matrixBaseOf(cloudBaseUrl, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim().replace(/\/+$/, '');
  const base = String(cloudBaseUrl ?? CLOUD_BASE);
  return base.replace('/minimax-cloud/api/v1', '/matrix/api/v1').replace(/\/+$/, '');
}

/**
 * Mark a schema node volatile.
 *
 * The host gates every settings write on `schema.meta.volatile` — an
 * undeclared field is refused with `Config field "X" is not volatile`, and the
 * card's switches die with that error.
 *
 * `Schema.prototype.volatile()` exists from schemastery 3.18.4 (the copy the
 * Desktop runtime ships at `resources/app/dsh/node_modules`), but the copy a
 * profile plugin reaches through the shared-layer junction is 3.18.1, which has
 * no such method. Calling it unguarded therefore throws at module load with
 * `volatile is not a function`. This sets the flag the host actually reads, so
 * the plugin works against either copy.
 */
function makeVolatile(schema) {
  if (typeof schema?.volatile === 'function') return schema.volatile();
  schema.meta.volatile = true;
  return schema;
}

/**
 * The user-configurable half of the settings document.
 *
 * Semantics are opt-OUT for the allow-lists, matching the sibling plugins: a
 * missing key means "offered", and only an explicit `false` disables. That way
 * a newly published MiniMax model appears without a settings migration.
 */
const ENABLED_MODEL_IDS_FIELD = makeVolatile(
  z.dict(z.boolean()).default({})
    .description('Per-model switch; a missing key is offered, only an explicit false disables'),
);
const IMAGE_OVERRIDES_FIELD = makeVolatile(
  z.dict(z.union([z.const('auto'), z.const('on'), z.const('off')])).default({})
    .description('Per-model image-input mode; auto follows the model catalog'),
);
const USE_MAXIMUM_CONTEXT_WINDOW_FIELD = makeVolatile(
  z.boolean().default(false)
    .description('Advertise the widest offered context window instead of the default'),
);

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE),
  cloudBaseUrl: z.string().default(CLOUD_BASE),
  /**
   * Commerce namespace (plan, credits, expiry). Derived from `cloudBaseUrl`
   * when left empty.
   */
  matrixBaseUrl: z.string().default(''),
  /**
   * Tokens are read from this file; it is the MiniMax Code credential store.
   *
   * Both paths default to the desktop client's own locations instead of being
   * required: a required field with no default makes the whole row
   * uninstantiable from `cordis.patch.yml` (which declares no config at all), and
   * the plugin would then never load.
   */
  authFile: z.string().default(defaultAuthFile()),
  /** Model roster source: the desktop client's own provider config. */
  configFile: z.string().default(defaultConfigFile()),
  statusRoute: z.string().default('/plugins/dsh-mm-models/minimax/status'),
  usageRoute: z.string().default('/plugins/dsh-mm-models/minimax/usage'),
  signinStatusRoute: z.string().default('/plugins/dsh-mm-models/minimax/signin'),
  claimRoute: z.string().default('/plugins/dsh-mm-models/minimax/signin/claim'),
  panelRoute: z.string().default('/plugins/dsh-mm-models/minimax/panel'),
  modelsRoute: z.string().default('/plugins/dsh-mm-models/minimax/models'),
  saveRoute: z.string().default('/plugins/dsh-mm-models/minimax/__save'),
  cacheMs: z.number().default(15_000),
  enabledModelIds: ENABLED_MODEL_IDS_FIELD,
  imageOverrides: IMAGE_OVERRIDES_FIELD,
  useMaximumContextWindow: USE_MAXIMUM_CONTEXT_WINDOW_FIELD,
});

/**
 * The fields a save may write, and the merge rule each uses.
 * `whole` replaces the field outright (the card always posts its complete value).
 */
const SAVE_FIELDS = {
  enabledModelIds: 'whole',
  imageOverrides: 'whole',
  useMaximumContextWindow: 'whole',
};

/**
 * The Loader row id this plugin is mounted under, i.e. the settings namespace.
 *
 * On the 0.2 line `SettingsForms.describe()` reports `ns: entry.options.id`, and
 * `entry.options.id` is the row id from `cordis.patch.yml` — NOT the package
 * name. The two are only equal by coincidence. `cordis.patch.yml` inserts the
 * row as `id: llm-minimax`, so that is the namespace a settings write must
 * address; falling back to the package name made every save answer "namespace
 * missing from describe()".
 */

/**
 * Namespace fallback when the host exposes no Loader entry id.
 *
 * This is the row id `cordis.patch.yml` inserts, not the package name: the
 * settings service addresses entries by `entry.options.id`, so the fallback has
 * to be the same string or a save answers "namespace missing from describe()".
 */
const FALLBACK_NS = 'mm-minimax';

/**
 * The namespace the host actually serves this plugin under.
 *
 * On the 0.2 line the settings service derives it from the Loader entry
 * (`ns: entry.options.id`, our row id `llm-minimax`); a host that mounts the
 * plugin without a Loader entry serves the plugin namespace instead.
 */
function settingsNamespaceOf(ctx, fallback) {
  const id = ctx?.fiber?.entry?.options?.id;
  return typeof id === 'string' && id !== '' ? id : fallback;
}

/** Unwrap a volatile reference (`{ get() }`) into its value. */
function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get === 'function') {
    try { return value.get(); } catch { return undefined; }
  }
  return value;
}

/** The settings row this plugin owns, matched exactly (never by substring). */
function findSettingsRow(rows, candidates) {
  for (const ns of candidates) {
    const row = rows.find((entry) => String(entry.ns) === ns);
    if (row !== undefined) return row;
  }
  return undefined;
}

// ---------------------------------------------------------------- credentials

/**
 * Where MiniMax Code keeps its OAuth records. The file lives under
 * `auth/prod/<region>/mcode-public/auth.json`; the token is scoped
 * `agent-backend` and is a plain Bearer value.
 */
function defaultAuthFile() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json');
}

function defaultConfigFile() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, '.minimax', 'config.yaml');
}

/**
 * Read the stored token. Returns `{ ok, token, expiresAtMs, reason }` and never
 * throws: a machine without MiniMax Code signed in must degrade to "not signed
 * in", not crash the loader.
 */
function readCredential(authFile) {
  const file = authFile || defaultAuthFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error.code ?? error.message}`, token: undefined };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `not JSON: ${error.message}`, token: undefined };
  }
  const records = parsed?.records ?? {};
  const first = Object.values(records)[0];
  const token = first?.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no accessToken record', token: undefined };
  }
  return {
    ok: true,
    token,
    tokenType: typeof first.tokenType === 'string' ? first.tokenType : 'Bearer',
    expiresAtMs: typeof first.expiresAtMs === 'number' ? first.expiresAtMs : undefined,
    refreshToken: typeof first.refreshToken === 'string' ? first.refreshToken : undefined,
    reason: undefined,
  };
}

// --------------------------------------------------------- credential renewal

/**
 * The OAuth record is renewed here, not only by the desktop client.
 *
 * MiniMax Code renews it roughly hourly and writes the result back to the same
 * file, and nothing else ever did — so the plugin went stale the moment the
 * desktop app was closed. Measured: HTTP 401 `invalid access token` on the
 * first request after expiry, with a perfectly good refreshToken sitting
 * unread in the record. The grant is therefore performed by this plugin as
 * well, against the same endpoint the first-party client uses:
 *
 *   POST https://account.minimax.cn/oauth2/token
 *        grant_type=refresh_token & refresh_token & client_id & scope & audience
 *        -> {access_token, refresh_token, token_type, expires_in, scope}
 *
 * `refresh_token` is single-use and rotates on every grant, so the old value
 * dies the instant the call answers and the new pair has to be stored before
 * the new access token is used. The write is an atomic replace (temp file then
 * rename) so the desktop client never observes a half-written record.
 *
 * The client serialises its own renewal with a file lock. The same race is
 * handled here by re-reading the file immediately before the write and
 * adopting any newer generation rather than clobbering it — same outcome, with
 * no lock to leak if this process dies mid-renewal.
 */
const OAUTH_TOKEN_ENDPOINT = 'https://account.minimax.cn/oauth2/token';
const OAUTH_CLIENT_ID = 'mcode-public';
const OAUTH_SCOPE = 'agent.default';
const OAUTH_AUDIENCE = 'agent-backend';

/** Renew this long before expiry, so a stream never opens on a dying token. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** After a refused grant, wait this long before touching the endpoint again. */
const RENEW_BACKOFF_MS = 5 * 60_000;

/** Wall-clock deadline for the current backoff window; 0 means "free to try". */
let renewBlockedUntil = 0;
/**
 * The refresh token the current backoff belongs to.
 *
 * A different token means the user signed in again in MiniMax Code, which is
 * the one condition the backoff must not survive: the provider has to come back
 * the moment a usable credential exists, not when a timer happens to expire.
 */
let renewBlockedToken;
/** Contention is not the endpoint's fault, so it parks for far less time. */
const RENEW_LOCK_RETRY_MS = 30_000;
/** In-flight grant, so concurrent requests share a single token exchange. */
let renewalInFlight = null;
/** Set by {@link apply}; module-level helpers have no `ctx` of their own. */
let hostLog = () => {};

function parkRenewal(ms, token) {
  renewBlockedUntil = Date.now() + ms;
  renewBlockedToken = token;
}

function unparkRenewal() {
  renewBlockedUntil = 0;
  renewBlockedToken = undefined;
}

/**
 * True while a previous failure still parks renewals — and false, with the park
 * lifted, as soon as the credential on disk is no longer the one that failed.
 */
function renewalParked(credential) {
  if (renewBlockedUntil === 0) return false;
  if (Date.now() >= renewBlockedUntil) { unparkRenewal(); return false; }
  if (credential?.refreshToken !== renewBlockedToken) { unparkRenewal(); return false; }
  return true;
}

/**
 * The whole stored record rather than just the token, because a renewal has to
 * rewrite it. `undefined` for anything unreadable or unparsable, which the
 * callers treat exactly as {@link readCredential} treats a missing login.
 */
function readCredentialRecord(authFile) {
  const file = authFile || defaultAuthFile();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const records = parsed?.records ?? {};
  const key = Object.keys(records)[0];
  if (key === undefined) return undefined;
  return { file, parsed, key, record: records[key] };
}

/**
 * True when the credential has no usable expiry or expires within the margin.
 * A record without `expiresAtMs` is treated as long-lived: refusing to try it
 * would break every older auth file for no reason.
 */
function expiresWithin(credential, marginMs) {
  if (typeof credential?.expiresAtMs !== 'number') return false;
  return credential.expiresAtMs - Date.now() <= marginMs;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/**
 * The cross-process lock the MiniMax Code client itself takes, reproduced.
 *
 * Both processes renew the *same* single-use refresh token, so they have to
 * serialise: two renewals racing on one token make the service treat the second
 * as a replay and revoke the whole token family — measured, and it costs the
 * user a fresh sign-in. The first-party client guards this with
 * `proper-lockfile` on `<namespaceHome>/auth.lock`; that module is not
 * resolvable from a plugin, so the same on-disk convention is rebuilt here:
 * the lock is a directory named `<lockPath>.lock`, `mkdir` is the atomic
 * acquisition, and a directory older than {@link AUTH_LOCK_STALE_MS} is
 * abandoned by its owner and reclaimed. That stale window matches the client's
 * own (`staleMs: 30_000`), so neither side steals a lock the other still holds.
 */
const AUTH_LOCK_STALE_MS = 30_000;
/** Give up rather than block a request forever behind a wedged holder. */
const AUTH_LOCK_WAIT_MS = 20_000;
const AUTH_LOCK_POLL_MS = 60;

/** The client's namespace keeps `auth.lock` next to `auth.json`. */
function authLockPath(authFile) {
  return path.join(path.dirname(authFile || defaultAuthFile()), 'auth.lock');
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function withAuthLock(lockPath, operation) {
  const directory = `${lockPath}.lock`;
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(directory);
      held = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(directory).mtimeMs;
      } catch {
        continue; // Released between the mkdir and the stat: try again at once.
      }
      if (ageMs > AUTH_LOCK_STALE_MS) {
        try { fs.rmdirSync(directory); } catch { /* somebody else reclaimed it first */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`held by another process for ${Math.round(ageMs)}ms`);
      await delay(AUTH_LOCK_POLL_MS);
    }
  }
  try {
    return await operation();
  } finally {
    try { fs.rmdirSync(directory); } catch { /* already reclaimed as stale */ }
  }
}

/** The generation `auth-state.json` currently advertises, or 0 when there is none. */
function readAuthStateGeneration(authFile) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(path.dirname(authFile), 'auth-state.json'), 'utf8'));
    return typeof state?.generation === 'number' && Number.isSafeInteger(state.generation) && state.generation >= 0 ? state.generation : 0;
  } catch {
    return 0;
  }
}

/**
 * Keep `auth-state.json` in step with the record just written.
 *
 * This is not advisory. `MCodeOAuthCore.readUsableCredential` refuses the pair
 * unless `credential.generation === state.generation`, so a token written into
 * `auth.json` without the matching companion bump reads back as "signed out"
 * and sends the user to a fresh sign-in. Both files therefore carry the same
 * generation, taken from {@link nextGeneration}.
 */
function mirrorAuthState(authFile, record) {
  const stateFile = path.join(path.dirname(authFile), 'auth-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    writeJsonAtomic(stateFile, { ...state, status: 'authenticated', generation: record.generation, expiresAtMs: record.expiresAtMs });
  } catch {
    /* no companion file, or nothing of ours to rewrite */
  }
}

/**
 * The generation for a replacement credential.
 *
 * The client computes `max(state.generation, credential.generation) + 1` and
 * refuses any pair whose two files disagree, so a renewal that used only the
 * credential's own counter could land *below* the companion file and lock the
 * account out of its own fresh token.
 */
function nextGeneration(authFile, record) {
  const fromState = readAuthStateGeneration(authFile);
  const fromRecord = typeof record?.generation === 'number' && Number.isSafeInteger(record.generation) ? record.generation : 0;
  return Math.max(fromState, fromRecord) + 1;
}

/**
 * Exchange the stored refresh token for a new pair.
 *
 * Never throws: every failure comes back as `{ ok: false, reason, fatal? }` so
 * a caller can keep serving the token already on disk. `fatal` marks the one
 * permanent answer, `invalid_grant`, where the refresh token itself is gone and
 * only a fresh sign-in in MiniMax Code can bring the provider back.
 */
async function renewCredential(authFile) {
  const initial = readCredentialRecord(authFile);
  if (initial === undefined) return { ok: false, reason: 'no credential record on disk' };
  if (typeof initial.record?.refreshToken !== 'string' || initial.record.refreshToken.length === 0) {
    return { ok: false, reason: 'record carries no refreshToken', fatal: true };
  }
  /**
   * Read, grant and write all happen inside the client's own lock, because the
   * refresh token is single-use: a grant whose result is not stored before the
   * next grant is a token the service reads as replayed, and a replay revokes
   * the entire token family (measured — it costs the user a fresh sign-in).
   * The record is re-read *inside* the lock as well: whoever held it before us
   * may already have rotated, in which case that newer pair is adopted rather
   * than spent.
   */
  try {
    return await withAuthLock(authLockPath(initial.file), async () => {
      const current = readCredentialRecord(initial.file);
      if (current === undefined) return { ok: false, reason: 'credential record vanished while waiting for the lock' };
      const previous = current.record ?? {};
      if (typeof previous.expiresAtMs === 'number' && previous.expiresAtMs - Date.now() > RENEW_MARGIN_MS) {
        return { ok: true, adopted: true, expiresAtMs: previous.expiresAtMs, generation: previous.generation };
      }
      let response;
      try {
        response = await fetch(OAUTH_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: previous.refreshToken,
            client_id: OAUTH_CLIENT_ID,
            scope: OAUTH_SCOPE,
            audience: OAUTH_AUDIENCE,
          }),
        });
      } catch (error) {
        return { ok: false, reason: `endpoint unreachable: ${error.cause?.code ?? error.message}` };
      }
      const text = await response.text();
      let grant;
      try { grant = JSON.parse(text); } catch { grant = undefined; }
      if (!response.ok || typeof grant?.access_token !== 'string') {
        const fatal = grant?.error === 'invalid_grant';
        return { ok: false, reason: `grant refused: HTTP ${response.status} ${text.slice(0, 200)}`, fatal };
      }
      const expiresIn = Number(grant.expires_in);
      const record = {
        ...previous,
        accessToken: grant.access_token,
        refreshToken: typeof grant.refresh_token === 'string' ? grant.refresh_token : previous.refreshToken,
        tokenType: 'Bearer',
        clientId: OAUTH_CLIENT_ID,
        scopes: [OAUTH_SCOPE],
        audience: OAUTH_AUDIENCE,
        expiresAtMs: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
        generation: nextGeneration(current.file, previous),
      };
      const payload = { ...current.parsed };
      payload.records = { ...(payload.records ?? {}), [current.key]: record };
      try {
        writeJsonAtomic(current.file, payload);
      } catch (error) {
        return { ok: false, reason: `renewed but could not be stored: ${error.message}` };
      }
      mirrorAuthState(current.file, record);
      return { ok: true, expiresAtMs: record.expiresAtMs, generation: record.generation };
    });
  } catch (error) {
    return { ok: false, reason: `could not take the credential lock: ${error.message}`, contended: true };
  }
}

/**
 * Renew once.
 *
 * Concurrent callers await the same exchange, and a refused grant parks the
 * next attempt behind {@link RENEW_BACKOFF_MS} instead of re-posting a dead
 * refresh token on every single request.
 */
function ensureRenewal(authFile) {
  if (renewalInFlight !== null) return renewalInFlight;
  const attempt = renewCredential(authFile).then(
    (result) => {
      renewalInFlight = null;
      const token = readCredential(authFile)?.refreshToken;
      if (result.ok) unparkRenewal();
      else {
        parkRenewal(result.contended ? RENEW_LOCK_RETRY_MS : RENEW_BACKOFF_MS, token);
        if (result.fatal) hostLog(`credential renewal impossible — ${result.reason}; sign in again in MiniMax Code`);
        else hostLog(`credential renewal failed — ${result.reason}`);
      }
      return result;
    },
    (error) => {
      renewalInFlight = null;
      parkRenewal(RENEW_BACKOFF_MS, readCredential(authFile)?.refreshToken);
      return { ok: false, reason: String(error?.message ?? error) };
    },
  );
  renewalInFlight = attempt;
  return attempt;
}

/**
 * A credential valid for at least {@link RENEW_MARGIN_MS}, renewing first when
 * the stored one is not.
 *
 * A failed renewal falls back to whatever is on disk: a stale token still beats
 * an unregistered provider while the endpoint is unreachable, and the next call
 * retries once the backoff expires.
 */
async function freshCredential(authFile) {
  const stored = readCredential(authFile);
  if (!stored.ok) return stored;
  if (!expiresWithin(stored, RENEW_MARGIN_MS)) return stored;
  if (renewalParked(stored)) return stored;
  const result = await ensureRenewal(authFile);
  if (!result.ok) return stored;
  const renewed = readCredential(authFile);
  return renewed.ok ? renewed : stored;
}

// ------------------------------------------------------------------- models

/**
 * Parse the model roster from the desktop client's config.yaml.
 *
 * A tiny hand-rolled reader instead of a YAML dependency: the file is machine
 * written and we only need `provider.minimax.models.<id>` plus that entry's
 * `name`, `limit.context` and `limit.output`. Anything unparsable falls back to
 * the four ids measured on this machine.
 */
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const FALLBACK_MODELS = [
  { id: 'MiniMax-M3.1-Flash', name: 'M3.1 Flash', context: 512_000, contextMax: 1_000_000, maxTokens: 128_000, reasoning: true, vision: true, video: true, thinking: 'forced_on', efforts: ['default', ...EFFORT_LEVELS], defaultEffort: 'default', maxAttachments: 4, reasoningSummary: 'auto' },
  { id: 'MiniMax-M3', name: 'M3', context: 512_000, contextMax: 1_000_000, maxTokens: 128_000, reasoning: true, vision: true, video: true, thinking: 'switchable', efforts: [], defaultEffort: null, maxAttachments: 9, reasoningSummary: 'auto' },
  { id: 'MiniMax-M2.7-highspeed', name: 'M2.7 highspeed', context: 200_000, contextMax: 200_000, maxTokens: 128_000, reasoning: true, vision: false, video: false, thinking: 'unknown', efforts: [], defaultEffort: null, maxAttachments: 0, reasoningSummary: null },
  { id: 'MiniMax-M2.7', name: 'M2.7', context: 200_000, contextMax: 200_000, maxTokens: 128_000, reasoning: true, vision: false, video: false, thinking: 'unknown', efforts: [], defaultEffort: null, maxAttachments: 0, reasoningSummary: null },
];

/** Leading-space count of one config.yaml line. */
function indentOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n += 1;
  return n;
}

/** A model entry as the roster reader builds it, before any user preference. */
function blankModel(id) {
  return {
    id,
    name: id,
    context: 200_000,
    contextMax: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    vision: false,
    /** `modalities.input` gained `video` in the 2026-10 desktop build. */
    video: false,
    /**
     * `thinking_config.mode` as published: `switchable`, `forced_on`, or
     * `unknown` when the build predates the field. Carried through so the card
     * can say whether the reasoning switch is the user's to flip.
     */
    thinking: 'unknown',
    /** `capabilities.support_files_api` — the desktop uploads attachments. */
    filesApi: false,
    /**
     * `thinking.effortOptions` as published (2026-11 build, M3.1-Flash only).
     * Empty means the build declares no effort ladder for this model, which is
     * not the same as "no thinking": `thinking` carries that answer.
     */
    efforts: [],
    /** `thinking.defaultEffort` — the level the desktop preselects. */
    defaultEffort: null,
    /** `capabilities.max_attachments_count`; 0 when the build declares none. */
    maxAttachments: 0,
    /** `options.reasoningSummary` — `auto` on the 2026-11 build. */
    reasoningSummary: null,
  };
}

/**
 * Parse the model roster from the desktop client's config.yaml.
 *
 * A hand-rolled reader instead of a YAML dependency: the file is machine
 * written, and only the shape under `models:` matters. The 2026-10 desktop build
 * widened that shape, so the reader now also follows:
 *
 *   modalities.input            -> image / video acceptance
 *   thinking_config.mode        -> whether reasoning is switchable or forced
 *   thinking.effortOptions[]    -> the effort ladder (2026-11 build)
 *   thinking.defaultEffort      -> the level the desktop preselects
 *   options.reasoningSummary    -> whether reasoning summaries are published
 *   capabilities.support_files_api -> whether uploads are available
 *   capabilities.max_attachments_count -> how many files one turn may carry
 *   contextWindowOptions[]      -> the widest window the plan offers
 *   contextWindowOptionHints    -> which option costs more ("higher_usage")
 *
 * Every matcher is anchored on the KEY rather than a fixed indent depth, so a
 * build that shifts the block by two spaces still parses. Anything unreadable
 * falls back to the ids measured on this machine.
 */
function parseModels(configFile) {
  let text;
  try {
    text = fs.readFileSync(configFile || defaultConfigFile(), 'utf8');
  } catch {
    return { models: FALLBACK_MODELS, source: 'fallback (config.yaml unreadable)', desktop: blankDesktop() };
  }
  const lines = text.split(/\r?\n/);
  const out = [];
  let inModels = false;
  let current = null;
  let inContextOptions = false;
  let inModalitiesInput = false;
  let inCapabilities = false;
  let inEffortOptions = false;
  let inModelOptions = false;
  for (const line of lines) {
    if (/^\s{4}models:\s*$/.test(line)) { inModels = true; continue; }
    if (!inModels) continue;
    if (/^\s{4}[a-zA-Z]/.test(line)) { inModels = false; continue; }
    const keyMatch = /^ {6}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (keyMatch) {
      current = blankModel(keyMatch[1]);
      out.push(current);
      inContextOptions = false;
      inModalitiesInput = false;
      inCapabilities = false;
      inEffortOptions = false;
      inModelOptions = false;
      continue;
    }
    if (current === null) continue;
    const nm = /^\s{8}name:\s*(.+?)\s*$/.exec(line);
    if (nm) { current.name = nm[1].replace(/^['"]|['"]$/g, ''); continue; }
    // `limit:` sits at indent 8 and its keys at 10 (measured), so the matchers
    // below are anchored on the KEY rather than a fixed depth.
    const cx = /^\s{8,12}context:\s*(\d+)\s*$/.exec(line);
    if (cx) { current.context = Number(cx[1]); current.contextMax = Math.max(current.contextMax, current.context); continue; }
    const ot = /^\s{8,12}output:\s*(\d+)\s*$/.exec(line);
    if (ot) { current.maxTokens = Number(ot[1]); continue; }
    // ---- modalities.input (a block list: `- text` / `- image` / `- video`)
    if (/^\s{8,12}modalities:\s*$/.test(line)) { inModalitiesInput = false; continue; }
    if (/^\s{8,12}input:\s*$/.test(line) && inModels) { inModalitiesInput = true; continue; }
    if (inModalitiesInput) {
      const item = /^\s{10,16}-\s*([a-z_]+)\s*$/.exec(line);
      if (item) {
        if (item[1] === 'image') current.vision = true;
        if (item[1] === 'video') current.video = true;
        continue;
      }
      if (!/^\s*$/.test(line)) inModalitiesInput = false;
    }
    // Older builds only publish the `- image` shorthand.
    if (/^\s{12}- image\s*$/.test(line)) { current.vision = true; continue; }
    // ---- thinking_config.mode
    const think = /^\s{8,12}mode:\s*(switchable|forced_on|forced_off|disabled)\s*$/.exec(line);
    if (think) { current.thinking = think[1]; continue; }
    // ---- thinking.effortOptions / thinking.defaultEffort (2026-11 build).
    // Anchored at exactly indent 8 so the `thinking:` keys nested inside
    // `variants` (indent 10 and deeper) cannot be mistaken for this block.
    if (/^ {8}thinking:\s*$/.test(line)) { inEffortOptions = false; continue; }
    if (/^ {10}effortOptions:\s*$/.test(line)) { inEffortOptions = true; continue; }
    if (inEffortOptions) {
      const opt = /^\s{12,16}-\s*([a-z]+)\s*$/.exec(line);
      if (opt) { current.efforts.push(opt[1]); continue; }
      if (!/^\s*$/.test(line)) inEffortOptions = false;
    }
    const def = /^ {10}defaultEffort:\s*([a-z]+)\s*$/.exec(line);
    if (def) { current.defaultEffort = def[1]; continue; }
    // ---- options.reasoningSummary (per-model `options:` block, indent 8)
    if (/^ {8}options:\s*$/.test(line)) { inModelOptions = true; continue; }
    if (inModelOptions) {
      const sum = /^ {10}reasoningSummary:\s*([a-z]+)\s*$/.exec(line);
      if (sum) { current.reasoningSummary = sum[1]; continue; }
      if (indentOf(line) > 8) continue;
      inModelOptions = false;
    }
    // ---- capabilities.support_files_api / max_attachments_count
    if (/^\s{8,12}capabilities:\s*$/.test(line)) { inCapabilities = true; continue; }
    if (inCapabilities) {
      const files = /^\s{10,16}support_files_api:\s*(true|false)\s*$/.exec(line);
      if (files) { current.filesApi = files[1] === 'true'; continue; }
      const cap = /^\s{10,16}max_attachments_count:\s*(\d+)\s*$/.exec(line);
      if (cap) { current.maxAttachments = Number(cap[1]); continue; }
      // `capabilities` holds several keys; only a line that dedents back to the
      // model level (indent <= 8) ends the block.
      if (indentOf(line) > 8) continue;
      inCapabilities = false;
    }
    // `contextWindowOptions:` is the widest window the plan offers; the option
    // named in `contextWindowOptionHints` as "higher_usage" is what the
    // max-context switch picks.
    if (/^\s{8,12}contextWindowOptions:\s*$/.test(line)) { inContextOptions = true; continue; }
    if (inContextOptions) {
      const opt = /^\s{10,16}-\s*(\d+)\s*$/.exec(line);
      if (opt) { current.contextMax = Math.max(current.contextMax, Number(opt[1])); continue; }
      if (!/^\s*$/.test(line)) inContextOptions = false;
    }
  }
  const desktop = parseDesktopFacts(lines);
  if (out.length === 0) return { models: FALLBACK_MODELS, source: 'fallback (no models parsed)', desktop };
  return { models: out, source: 'config.yaml', desktop };
}

/** A model entry as the roster reader builds it, before any user preference. */
function blankDesktop() {
  return { defaultModel: null, modelOrder: [], defaultEffort: null, defaultContextWindow: null };
}

/**
 * The desktop client's own defaults, which sit outside `models:`.
 *
 * `defaultModel` is written as `provider/model`, and the effort/context defaults
 * are what MiniMax Code preselects for a fresh conversation — the panel quotes
 * them so the user can see whether DSH is configured the same way.
 */
function parseDesktopFacts(lines) {
  const out = blankDesktop();
  let inModelOrder = false;
  let inThinking = false;
  for (const line of lines) {
    if (/^defaultModel:\s*(\S+)\s*$/.test(line)) {
      out.defaultModel = /^defaultModel:\s*(\S+)\s*$/.exec(line)[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const cw = /^defaultModelContextWindow:\s*(\d+)\s*$/.exec(line);
    if (cw) { out.defaultContextWindow = Number(cw[1]); continue; }
    if (/^defaultModelThinking:\s*$/.test(line)) { inThinking = true; continue; }
    if (inThinking) {
      const ef = /^ {2}effort:\s*([a-z]+)\s*$/.exec(line);
      if (ef) { out.defaultEffort = ef[1]; continue; }
      if (!/^\s*$/.test(line) && indentOf(line) === 0) inThinking = false;
    }
    if (/^ {4}model_order:\s*$/.test(line)) { inModelOrder = true; continue; }
    if (inModelOrder) {
      const id = /^ {6}-\s*(\S+)\s*$/.exec(line);
      if (id) { out.modelOrder.push(id[1]); continue; }
      if (!/^\s*$/.test(line)) inModelOrder = false;
    }
  }
  return out;
}

/**
 * pi-ai's effort ladder for one model, or `undefined` when the wire carries no
 * effort at all.
 *
 * The 2026-11 desktop build publishes `thinking.effortOptions` for
 * `MiniMax-M3.1-Flash` only, and that model *rejects* `thinking.type=disabled`
 * with HTTP 400 ("requires adaptive thinking"). So for it:
 *
 *   - `compat.forceAdaptiveThinking` makes pi-ai send `thinking.type=adaptive`
 *     plus `output_config.effort` instead of a token budget, which is the shape
 *     the service accepts;
 *   - `off` maps to `null`, which makes pi-ai drop it from the selectable
 *     levels rather than sending a request the service refuses.
 *
 * `minimal` is not a MiniMax level; it folds into `low`. A model with no
 * published ladder keeps pi-ai's budget-based path, which the service accepts
 * for the switchable models.
 */
function thinkingMapOf(m) {
  if (!Array.isArray(m.efforts) || m.efforts.length === 0) return undefined;
  const has = (level) => m.efforts.includes(level);
  const map = { off: null };
  if (has('low')) map.minimal = 'low';
  for (const level of EFFORT_LEVELS) if (has(level)) map[level] = level;
  return map;
}

/**
 * One pi-ai model descriptor for the Anthropic Messages API, honouring the
 * user's switches.
 *
 * @param prefs - the resolved preferences; `enabledIds`, `imageModes`,
 *   `preferMaximumContext`. Judged per call so a settings save takes effect on
 *   the next model build without re-registering the provider.
 */
function toPiModel(m, baseUrl, prefs = {}) {
  const imageMode = prefs.imageModes?.[m.id] ?? 'auto';
  const wantsImage = imageMode === 'on' || (imageMode === 'auto' && m.vision === true);
  const width = prefs.preferMaximumContext === true && m.contextMax ? m.contextMax : m.context;
  const thinkingLevelMap = thinkingMapOf(m);
  return {
    id: m.id,
    name: m.name,
    api: 'anthropic-messages',
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: m.reasoning !== false,
    /**
     * pi-ai's `input` is the modality list it will accept on a request. Video is
     * deliberately NOT advertised even when the catalog lists it: the Anthropic
     * Messages transport this plugin speaks has no video content block, so
     * claiming it would turn a clean "unsupported" into a malformed request.
     */
    input: wantsImage ? ['text', 'image'] : ['text'],
    // Points-based plan: no per-token price is published, so cost stays at 0
    // rather than inventing a number the panel would then display as truth.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: width,
    maxTokens: m.maxTokens,
    /** Carried for the card only; pi-ai ignores unknown descriptor fields. */
    imageMode,
    ...thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap, compat: { forceAdaptiveThinking: true } },
  };
}

/**
 * Keep the models the user left enabled.
 *
 * Opt-out: an id with no entry is offered, and only an explicit `false` removes
 * it. An empty allow-list therefore means "everything", not "nothing" — which
 * is what keeps a freshly published model visible.
 */
function filterByEnabled(models, enabledIds) {
  if (enabledIds === null || typeof enabledIds !== 'object') return models;
  return models.filter((m) => enabledIds[m.id] !== false);
}

// ---------------------------------------------------------------------- http

async function callJson(url, credential, init = {}) {
  const headers = {
    authorization: `${credential.tokenType ?? 'Bearer'} ${credential.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...(init.headers ?? {}),
  };
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { status: response.status, body };
}

const TZ = 'Asia/Shanghai';

/** A credit amount as a number, or null when the service did not send one. */
function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Find the usage multiplier ("倍用量") in a membership payload.
 *
 * The factor is only published for accounts that own a token plan, and the
 * field name has moved between builds. Rather than hard-code one name, the
 * payload is searched for a numeric multiplier-ish field; when there is none,
 * nothing is invented and the card says the service did not report it.
 */
function findMultiplier(payload, depth = 0) {
  if (payload === null || typeof payload !== 'object' || depth > 3) return null;
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && /multiplier|multiple|times/i.test(key)) {
      return value;
    }
  }
  for (const value of Object.values(payload)) {
    if (value !== null && typeof value === 'object') {
      const found = findMultiplier(value, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Read the account's plan, quota and expiry.
 *
 * Two matrix routes, POST with a JSON body:
 *   `/matrix/api/v1/user/get_user_extra_info`     — workspaces and personal plan
 *   `/matrix/api/v1/commerce/get_membership_info` — plan, credits, expiry
 *
 * Measured on a free account, `get_membership_info` answers:
 *   `{plan_type, plan_name, next_plan_name, will_renewal, expires_at,
 *     total_remains_credit, pending_credit, has_token_plan, subscription_type,
 *     opcredit_balance, upgrade_action, can_upgrade,
 *     op_credit_summary:{total_remaining_amount, purchased_remaining_amount,
 *     free_remaining_amount}, base_resp:{status_code}}`
 *
 * A subscribed account fills the tier fields in there; anything the service
 * does not send is reported as unknown rather than invented here.
 */
async function collectMembership(resolved, credential) {
  const out = {
    ok: false,
    reason: null,
    planName: null,
    planType: null,
    subscriptionType: null,
    hasTokenPlan: false,
    willRenew: false,
    expiresAtMs: null,
    upgradeAction: null,
    canUpgrade: false,
    multiplier: null,
    remaining: null,
    purchasedRemaining: null,
    freeRemaining: null,
    pendingCredit: null,
    dailyGiftRemaining: null,
    opBalance: null,
    opGroupId: null,
    workspaceName: null,
    memberNum: null,
    personalPlanType: null,
  };

  try {
    const r = await callJson(`${resolved.matrixBaseUrl}/user/get_user_extra_info`, credential, { method: 'POST', body: '{}' });
    if (r.status === 200 && r.body?.base_resp?.status_code === 0) {
      const workspaces = Array.isArray(r.body.workspaces) ? r.body.workspaces : [];
      const personal = workspaces.find((w) => w?.selected === true) ?? workspaces[0];
      if (personal) {
        out.workspaceName = typeof personal.workspace_name === 'string' ? personal.workspace_name : null;
        out.memberNum = typeof personal.member_num === 'number' ? personal.member_num : null;
        out.personalPlanType = typeof personal.personal_plan_type === 'number' ? personal.personal_plan_type : null;
        out.opGroupId = typeof personal.op_group_id === 'string' ? personal.op_group_id : null;
      }
    } else {
      out.reason = `user/get_user_extra_info -> HTTP ${r.status} ${JSON.stringify(r.body?.base_resp ?? r.body).slice(0, 160)}`;
    }
  } catch (error) {
    out.reason = `user/get_user_extra_info -> ${error.cause?.code ?? error.message}`;
  }

  try {
    const r = await callJson(`${resolved.matrixBaseUrl}/commerce/get_membership_info`, credential, { method: 'POST', body: '{}' });
    if (r.status === 200 && r.body?.base_resp?.status_code === 0) {
      const body = r.body;
      const summary = body.op_credit_summary ?? {};
      const expires = Number(body.expires_at);
      out.ok = true;
      out.planName = typeof body.plan_name === 'string' && body.plan_name !== '' ? body.plan_name : null;
      out.planType = typeof body.plan_type === 'number' ? body.plan_type : null;
      out.subscriptionType = typeof body.subscription_type === 'string' ? body.subscription_type : null;
      out.hasTokenPlan = body.has_token_plan === true;
      out.willRenew = body.will_renewal === true;
      out.expiresAtMs = Number.isFinite(expires) && expires > 0 ? (expires < 1e12 ? expires * 1000 : expires) : null;
      out.upgradeAction = typeof body.upgrade_action === 'string' ? body.upgrade_action : null;
      out.canUpgrade = body.can_upgrade === true;
      out.pendingCredit = toAmount(body.pending_credit);
      out.dailyGiftRemaining = toAmount(body.daily_login_gift_credit_remaining);
      out.opBalance = toAmount(body.opcredit_balance);
      out.remaining = toAmount(summary.total_remaining_amount ?? body.total_remains_credit);
      out.purchasedRemaining = toAmount(summary.purchased_remaining_amount);
      out.freeRemaining = toAmount(summary.free_remaining_amount);
      out.multiplier = findMultiplier(body);
    } else {
      out.reason = `commerce/get_membership_info -> HTTP ${r.status} ${JSON.stringify(r.body?.base_resp ?? r.body).slice(0, 160)}`;
    }
  } catch (error) {
    out.reason = `commerce/get_membership_info -> ${error.cause?.code ?? error.message}`;
  }

  return out;
}

// --------------------------------------------------------------------- panel

/**
 * Snapshot for the settings card: sign-in state, points, and the model roster.
 * Read-only; the claim is a separate POST route.
 */
async function collectSnapshot(resolved) {
  const credential = await freshCredential(resolved.authFile);
  const roster = parseModels(resolved.configFile);
  const out = {
    signedIn: credential.ok,
    reason: credential.reason,
    expiresAtMs: credential.expiresAtMs,
    // `selfRenewal` tells the card whether this plugin can keep the sign-in
    // alive on its own, i.e. whether MiniMax Code still has to be running.
    selfRenewal: {
      marginMs: RENEW_MARGIN_MS,
      backoffMs: RENEW_BACKOFF_MS,
      blocked: Date.now() < renewBlockedUntil && renewBlockedToken === credential.refreshToken,
      blockedUntil: renewBlockedUntil || null,
      inFlight: renewalInFlight !== null,
      hasRefreshToken: typeof credential.refreshToken === 'string' && credential.refreshToken.length > 0,
      // How many times this plugin has replaced the token on its own. A
      // non-zero count is the receipt for "no need to keep MiniMax Code open".
      generation: readAuthStateGeneration(resolved.authFile),
    },
    baseUrl: resolved.baseUrl,
    models: roster.models,
    modelsSource: roster.source,
    /** The desktop client's own defaults, quoted so the card can compare. */
    desktop: roster.desktop,
    points: null,
    signin: null,
    membership: null,
    errors: [],
  };
  if (!credential.ok) return out;

  try {
    const r = await callJson(`${resolved.cloudBaseUrl}/credit/details`, credential);
    if (r.status === 200 && r.body?.base_resp?.status_code === 0) {
      const rows = Array.isArray(r.body.details) ? r.body.details : [];
      let remaining = 0;
      let granted = 0;
      let consumed = 0;
      let expireAtMs;
      for (const row of rows) {
        remaining += Number(row.remaining_amount ?? 0) || 0;
        granted += Number(row.granted_amount ?? 0) || 0;
        consumed += Number(row.consumed_amount ?? 0) || 0;
        if (typeof row.expire_at_ms === 'number' && (expireAtMs === undefined || row.expire_at_ms < expireAtMs)) {
          expireAtMs = row.expire_at_ms;
        }
      }
      out.points = { remaining, granted, consumed, expireAtMs, rows: rows.length };
    } else {
      out.errors.push(`credit/details -> HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  } catch (error) {
    out.errors.push(`credit/details -> ${error.cause?.code ?? error.message}`);
  }

  try {
    const r = await callJson(`${resolved.cloudBaseUrl}/signin/status?timezone_id=${encodeURIComponent(TZ)}`, credential);
    if (r.status === 200 && r.body?.base_resp?.status_code === 0) {
      const days = Array.isArray(r.body.data?.days) ? r.body.data.days : [];
      const today = days.find((d) => d.is_today === true);
      out.signin = {
        scene: r.body.data?.scene,
        days: days.map((d) => ({ day: d.day_no, points: d.points, bonus: d.bonus_points, status: d.status, today: d.is_today === true })),
        // status 3 = claimed (measured: day 1 came back with status 3 and is_today).
        // Anything else on today's row counts as claimable: a status value this
        // build has never seen must not leave the button dead forever.
        claimedToday: today?.status === 3,
        claimableToday: today === undefined ? true : today.status !== 3,
        todayStatus: today?.status ?? null,
        todayPoints: today?.points ?? 0,
      };
    } else {
      out.errors.push(`signin/status -> HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  } catch (error) {
    out.errors.push(`signin/status -> ${error.cause?.code ?? error.message}`);
  }

  try {
    out.membership = await collectMembership(resolved, credential);
    if (!out.membership.ok && out.membership.reason) out.errors.push(out.membership.reason);
  } catch (error) {
    out.membership = { ok: false, reason: `membership -> ${error.cause?.code ?? error.message}` };
    out.errors.push(out.membership.reason);
  }

  return out;
}

/**
 * Claim the daily check-in.
 *
 * The empty body matches the first-party client, but the `timezone_id` query
 * parameter is required on this route too: the POST rejects with 1406010011
 * "invalid timezone_id" without it (measured).
 */
async function claimCheckin(resolved) {
  const credential = await freshCredential(resolved.authFile);
  if (!credential.ok) return { ok: false, error: `not signed in: ${credential.reason}` };
  const url = `${resolved.cloudBaseUrl}/signin/claim?timezone_id=${encodeURIComponent(TZ)}`;
  try {
    const r = await callJson(url, credential, { method: 'POST', body: '{}' });
    const code = r.body?.base_resp?.status_code;
    if (r.status === 200 && code === 0) return { ok: true, data: r.body.data ?? null };
    return { ok: false, error: r.body?.base_resp?.status_msg ?? `HTTP ${r.status}`, code };
  } catch (error) {
    return { ok: false, error: String(error.cause?.code ?? error.message) };
  }
}

// ------------------------------------------------------------------ adapter

/**
 * Defaults for the request-image budgets the 0.2 adapter reads off the profile.
 *
 * `resolveProfiles` would fill these in for a provider declared through
 * `llm-pi-ai`'s own config, but this plugin builds its profile by hand, so the
 * values have to be spelled out or `toPiContext` receives `undefined` for all
 * three and the image path degrades to "no policy".
 */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;

/**
 * Build the PiAiAdapter over the parsed models. One provider id (`minimax`)
 * carries the whole roster, matching how the desktop client presents them.
 *
 * `readPrefs` is called per rebuild rather than captured once, so a settings
 * save changes the roster without re-registering the provider.
 *
 * The returned `invalidate()` is the settings-save hook: it drops the cached
 * profile map so the next read rebuilds it from the fresh preferences, and the
 * `llm/adapters-updated` signal then makes the picker re-read the roster.
 *
 * @returns `{adapter, error, models, invalidate}` — `adapter` is null when a
 *   peer package is missing, in which case `error` says which.
 */
async function buildAdapter(resolved, roster, readPrefs, host) {
  const p = await loadPeers();
  // Each slot already holds the exported function itself, not the module.
  if (typeof p.piAi !== 'function' || typeof p.anthropic !== 'function' || typeof p.adapter !== 'function') {
    return { adapter: null, error: `peer packages unavailable: ${p.errors.join('; ') || 'unknown'}`, models: [], invalidate() {} };
  }
  const createProvider = p.piAi;
  const anthropicMessagesApi = p.anthropic;
  const Adapter = p.adapter;

  const buildModels = (prefs) => filterByEnabled(roster.models, prefs.enabledIds)
    .map((m) => toPiModel(m, resolved.baseUrl, prefs));

  /**
   * The provider object, rebuilt whenever the preferences move.
   *
   * `getModels` is overridden on the returned object (rather than relying on the
   * `models` array handed to `createProvider`) because the model picker calls it
   * on every projection: reading fresh here is what makes a switch flip visible
   * without tearing the provider down.
   */
  const buildProvider = (prefs) => {
    const models = buildModels(prefs);
    return {
      ...createProvider({
        id: PROVIDER_ID,
        name: 'MiniMax Code',
        auth: {
          apiKey: {
            name: 'MiniMax Code credential',
            resolve: async () => {
              // Waits for a renewal when the stored token is about to expire, so
              // the provider keeps answering with MiniMax Code closed.
              const credential = await freshCredential(resolved.authFile);
              if (!credential.ok) return undefined;
              return { auth: { headers: { Authorization: `${credential.tokenType ?? 'Bearer'} ${credential.token}` } }, source: 'MiniMax Code sign-in' };
            },
          },
        },
        models,
        api: anthropicMessagesApi(),
      }),
      getModels: () => buildModels(readPrefs?.() ?? {}),
    };
  };

  /**
   * `profile.headers` is merged into every request (`requestHeaders(profile.headers)`
   * inside the adapter), and that read happens per stream rather than once at
   * registration. A getter is therefore used instead of a snapshot, so a token
   * renewed after startup is picked up without rebuilding the provider.
   *
   * MiniMax wants `Authorization: Bearer`, not Anthropic's `x-api-key` — sending
   * the key through `apiKey` produced "401 token is required" (measured).
   */
  const buildProfile = (provider) => {
    const profile = {
      provider: PROVIDER_ID,
      displayName: 'MiniMax Code',
      streamIdleTimeoutMs: 180_000,
      maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
      requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
      requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      piProvider: provider,
    };
    Object.defineProperty(profile, 'headers', {
      enumerable: true,
      get() {
        const credential = readCredential(resolved.authFile);
        if (!credential.ok) return {};
        /**
         * Synchronous by contract, so a renewal cannot be awaited here: hand
         * back the token that is on disk and renew in the background, which
         * lands well before the next stream. The path that *does* wait is the
         * provider's own `resolve` above, and the timer in `apply` keeps the
         * record fresh even when no request is in flight — together those are
         * what let this plugin run with MiniMax Code closed.
         */
        if (expiresWithin(credential, RENEW_MARGIN_MS) && !renewalParked(credential)) {
          void ensureRenewal(resolved.authFile).then((result) => {
            if (result.ok) hostLog(`credential renewed ahead of expiry; valid until ${new Date(result.expiresAtMs ?? 0).toISOString()}`);
          });
        }
        return { Authorization: `${credential.tokenType ?? 'Bearer'} ${credential.token}` };
      },
    });
    return profile;
  };

  /**
   * `PiAiAdapter.current()` memoises on the *identity* of the map `profiles()`
   * returns (`if (this.snapshot?.profiles === profiles) return this.snapshot`),
   * so handing back a fresh Map on every call would rebuild `createModels()` and
   * re-register the provider on every token of every stream. The cache is keyed
   * on a generation counter that only a settings save bumps.
   */
  let generation = 0;
  let cached = { generation: -1, profiles: null };
  const profiles = () => {
    if (cached.generation === generation && cached.profiles !== null) return cached.profiles;
    const provider = buildProvider(readPrefs?.() ?? {});
    cached = { generation, profiles: new Map([[PROVIDER_ID, buildProfile(provider)]]) };
    return cached.profiles;
  };
  const invalidate = () => { generation += 1; };

  const adapter = new Adapter({
    profiles,
    // Credentials ride on the provider's own resolve(); the adapter-level hook
    // stays inert so there is exactly one place the token is read.
    resolveApiKey: async () => undefined,
    /**
     * Both image hooks are required the moment a message carries an image.
     * Without `resolveAttachments` the adapter throws `pi-ai image input
     * requires the durable attachment service` (UNSUPPORTED_CONTENT) before the
     * request leaves; without `resolveImageAccess` it cannot turn the attachment
     * reference into a readable path and fails one call deeper.
     *
     * This is the same wiring the shipped `llm-pi-ai` route uses, so the plugin
     * no longer needs the `{maxPixels,maxBytes}` / `{width,height,maxBytes}`
     * translation layer the 0.1 line required.
     */
    resolveAttachments: () => host.attachments(),
    resolveImageAccess: (attachments, ref) => (
      typeof p.llm === 'function'
        ? p.llm(attachments, (hostPath) => host.processPathFromHostPath(hostPath), ref)
        : undefined
    ),
  });
  return { adapter, error: undefined, models: buildModels(readPrefs?.() ?? {}), invalidate };
}
// --------------------------------------------------------------------- apply

function isLoopback(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  const normalised = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalised === '::1' || normalised === '127.0.0.1' || normalised.startsWith('127.');
}

function send(response, status, body, contentType) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Diagnostics handle.
 *
 * The host only ever calls {@link apply}, but the renewal path is worth
 * reaching from a one-off script: it runs solely while the stored token sits
 * inside {@link RENEW_MARGIN_MS} of expiry, which is a state that cannot be
 * arranged on demand and is exactly the path that decides whether MiniMax Code
 * still has to be running. Exporting the internals keeps that verifiable
 * without standing up a host. Inert otherwise — nothing here runs at load.
 */
export const __diagnostics = {
  renewCredential,
  freshCredential,
  readCredential,
  readCredentialRecord,
  nextGeneration,
  expiresWithin,
  mirrorAuthState,
  defaultAuthFile,
  defaultConfigFile,
  parseModels,
  toPiModel,
  thinkingMapOf,
  filterByEnabled,
  settingsNamespaceOf,
  RENEW_MARGIN_MS,
  OAUTH_TOKEN_ENDPOINT,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  OAUTH_AUDIENCE,
};

export function apply(ctx, config) {
  const resolved = {
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
    cloudBaseUrl: config.cloudBaseUrl ?? CLOUD_BASE,
    matrixBaseUrl: matrixBaseOf(config.cloudBaseUrl ?? CLOUD_BASE, config.matrixBaseUrl),
    authFile: config.authFile || defaultAuthFile(),
    configFile: config.configFile || defaultConfigFile(),
    statusRoute: config.statusRoute ?? '/plugins/dsh-mm-models/minimax/status',
    usageRoute: config.usageRoute ?? '/plugins/dsh-mm-models/minimax/usage',
    signinStatusRoute: config.signinStatusRoute ?? '/plugins/dsh-mm-models/minimax/signin',
    claimRoute: config.claimRoute ?? '/plugins/dsh-mm-models/minimax/signin/claim',
    panelRoute: config.panelRoute ?? '/plugins/dsh-mm-models/minimax/panel',
    modelsRoute: config.modelsRoute ?? '/plugins/dsh-mm-models/minimax/models',
    saveRoute: config.saveRoute ?? '/plugins/dsh-mm-models/minimax/__save',
    cacheMs: config.cacheMs ?? 15_000,
  };
  const log = (m) => ctx.logger?.info?.(`mm-minimax: ${m}`);
  hostLog = log;

  /**
   * The settings namespace the host serves this plugin under, resolved once
   * from the Loader entry id (see {@link settingsNamespaceOf}).
   */
  const settingsNs = settingsNamespaceOf(ctx, FALLBACK_NS);

  /**
   * The live settings document, read through `config`'s own volatile fields.
   *
   * `config` is the Loader-provided configuration object, whose volatile fields
   * expose `{ get() }`. Reading it per call is what makes a save visible to the
   * next model build without a restart.
   */
  const readPreferences = () => ({
    enabledIds: unwrapVolatile(config.enabledModelIds) ?? {},
    imageModes: unwrapVolatile(config.imageOverrides) ?? {},
    preferMaximumContext: unwrapVolatile(config.useMaximumContextWindow) === true,
  });

  // ---- provider registration (best effort; the card still works without it)
  const roster = parseModels(resolved.configFile);
  let releaseAdapter;
  let releaseDirectory;
  let adapterHandle;
  /**
   * Everything the adapter needs from the host, resolved lazily.
   *
   * `ctx.get()` is called at request time rather than captured here: the
   * attachment and fs services are registered by other entries and may not
   * exist yet when this plugin's `apply` runs.
   */
  const hostBridge = {
    attachments: () => ctx.get('attachments'),
    processPathFromHostPath: (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
  };
  // The adapter build is async (peers are ESM), so it runs detached: a slow or
  // failing peer must never delay the routes the card needs, and the settings
  // surface stays available either way.
  loadPeers()
    .then(async (peers) => {
      if (typeof peers.piAi !== 'function') {
        ctx.logger?.warn?.(`mm-minimax: provider not registered — ${peers.errors.join('; ') || 'pi-ai unavailable'}`);
        return;
      }
      const built = await buildAdapter(resolved, roster, readPreferences, hostBridge);
      if (built.adapter === null) {
        ctx.logger?.warn?.(`mm-minimax: provider not registered — ${built.error}`);
        return;
      }
      adapterHandle = built.adapter;
      try {
        releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], built.adapter);
        const active = readPreferences();
        log(`provider "${PROVIDER_ID}" registered with ${filterByEnabled(roster.models, active.enabledIds).length}/${roster.models.length} models (from ${roster.source})`);
      } catch (error) {
        ctx.logger?.error?.('mm-minimax: registerAdapter failed', error);
      }
      /**
       * Declare the route to the settings/model surface.
       *
       * `registerAdapter` alone only makes the provider routable — it does NOT
       * put it in the model picker. The picker is built from the llm service's
       * configurable-provider directory, so without this call the provider
       * answers requests but appears nowhere in the UI (measured: exactly the
       * "models are missing from the selector" symptom).
       *
       * `settingsNs` must be a namespace the settings service actually serves
       * (`registerConfigurableProviders` merely *addresses* it), and on the 0.2
       * line that namespace is the Loader row id. `settingsPath` stays empty
       * because this plugin's Config is flat — the volatile fields live at the
       * root, so there is no sub-schema for the host to walk.
       */
      try {
        releaseDirectory = ctx.llm.registerConfigurableProviders([{
          provider: PROVIDER_ID,
          displayName: 'MiniMax Code',
          settingsNs,
          settingsPath: [],
          declared: false,
        }]);
      } catch (error) {
        ctx.logger?.error?.('mm-minimax: registerConfigurableProviders failed; the provider stays routable but will not appear in the model picker', error);
      }
    })
    .catch((error) => ctx.logger?.error?.('mm-minimax: provider setup failed', error));
  ctx.effect(() => () => {
    try { releaseDirectory?.(); } catch { /* disposed twice is harmless */ }
    try { releaseAdapter?.(); } catch { /* disposed twice is harmless */ }
  }, 'mm-minimax: adapter lifecycle');

  /**
   * Proactive renewal.
   *
   * MiniMax Code expires this record hourly, and a turn that opens on a token
   * with seconds left dies mid-stream. Polling once a minute keeps the stored
   * credential comfortably ahead of that whether or not any request happens to
   * be in flight, and it is the reason this plugin survives the desktop app
   * being closed. The timer is unref'd so it can never hold the host open, and
   * it is torn down with the plugin.
   */
  ctx.effect(() => {
    const timer = setInterval(() => {
      const credential = readCredential(resolved.authFile);
      if (!credential.ok) return;
      if (!expiresWithin(credential, RENEW_MARGIN_MS)) return;
      if (renewalParked(credential)) return;
      void ensureRenewal(resolved.authFile);
    }, 60_000);
    timer?.unref?.();
    return () => clearInterval(timer);
  }, 'mm-minimax: credential renewal');

  /**
   * Tell the host the roster moved, so the picker re-reads it.
   *
   * Two separate steps, and both are needed on the 0.2 line:
   *
   *   `invalidate()` drops the adapter's cached profile map, so the next
   *   `profiles()` call rebuilds it from the preferences that were just saved.
   *   The `llm/adapters-updated` event then makes the picker re-read
   *   `getModels()`.
   *
   * `registerAdapter`'s handle also offers `replace()`, which emits the event
   * itself — but it re-commits the routes, and the provider object is unchanged
   * here, so the lighter signal is enough.
   */
  const refreshPicker = () => {
    try {
      adapterHandle?.invalidate?.();
      ctx.emit?.('llm/adapters-updated');
    } catch (error) {
      ctx.logger?.warn?.('mm-minimax: could not signal the model picker', error);
    }
  };

  // ---- status cache (check-in mutates the balance, so it is invalidated)
  let cache = { at: 0, value: null };
  const snapshot = async () => {
    const now = Date.now();
    if (cache.value !== null && now - cache.at < resolved.cacheMs) return cache.value;
    const value = await collectSnapshot(resolved);
    cache = { at: now, value };
    return value;
  };
  const invalidate = () => { cache = { at: 0, value: null }; };

  // ---- routes
  ctx.inject(['webServer'], (webCtx) => {
    const guard = (method) => (request, response) => {
      if (request.method !== method) { send(response, 405, { error: `${method} only` }, 'application/json'); return false; }
      if (!isLoopback(request.socket?.remoteAddress)) { send(response, 403, { error: 'loopback only' }, 'application/json'); return false; }
      return true;
    };

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.statusRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        try { send(response, 200, await snapshot(), 'application/json'); }
        catch (error) { send(response, 500, { error: error.message }, 'application/json'); }
      },
    }), `mm-minimax: GET ${resolved.statusRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.usageRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        const credential = await freshCredential(resolved.authFile);
        if (!credential.ok) { send(response, 200, { signedIn: false, reason: credential.reason }, 'application/json'); return; }
        try {
          const r = await callJson(`${resolved.cloudBaseUrl}/credit/details`, credential);
          send(response, 200, { signedIn: true, ...r.body }, 'application/json');
        } catch (error) { send(response, 502, { error: String(error.cause?.code ?? error.message) }, 'application/json'); }
      },
    }), `mm-minimax: GET ${resolved.usageRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.signinStatusRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        const credential = await freshCredential(resolved.authFile);
        if (!credential.ok) { send(response, 200, { signedIn: false, reason: credential.reason }, 'application/json'); return; }
        try {
          const r = await callJson(`${resolved.cloudBaseUrl}/signin/status?timezone_id=${encodeURIComponent(TZ)}`, credential);
          send(response, 200, { signedIn: true, ...r.body }, 'application/json');
        } catch (error) { send(response, 502, { error: String(error.cause?.code ?? error.message) }, 'application/json'); }
      },
    }), `mm-minimax: GET ${resolved.signinStatusRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.claimRoute,
      handler: async (request, response) => {
        if (!guard('POST')(request, response)) return;
        try {
          const result = await claimCheckin(resolved);
          invalidate();
          send(response, result.ok ? 200 : 502, result, 'application/json');
        } catch (error) { send(response, 500, { error: error.message }, 'application/json'); }
      },
    }), `mm-minimax: POST ${resolved.claimRoute}`);

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.panelRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        send(response, 200, renderPanel(resolved), 'text/html');
      },
    }), `mm-minimax: GET ${resolved.panelRoute}`);

    /**
     * The model rows the card renders, with the user's saved choices applied.
     * Read from the host rather than the settings document: the roster is live
     * catalog state, and the catalogue is local, so `?refresh=1` simply re-reads
     * config.yaml and picks up models MiniMax added to the desktop client.
     */
    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.modelsRoute,
      handler: async (request, response) => {
        if (!guard('GET')(request, response)) return;
        try {
          const fresh = String(request.url ?? '').includes('refresh=1')
            ? parseModels(resolved.configFile)
            : roster;
          const prefs = readPreferences();
          send(response, 200, {
            source: fresh.source,
            desktop: fresh.desktop,
            models: fresh.models.map((m) => ({
              id: m.id,
              name: m.name,
              context: m.context,
              contextMax: m.contextMax ?? m.context,
              maxTokens: m.maxTokens,
              vision: m.vision === true,
              /** Catalog modality the transport cannot carry; shown, not offered. */
              video: m.video === true,
              /** `switchable` means the reasoning toggle is the user's to flip. */
              thinking: m.thinking ?? 'unknown',
              filesApi: m.filesApi === true,
              /** 2026-11 build: the effort ladder and the desktop's preselected rung. */
              efforts: Array.isArray(m.efforts) ? m.efforts : [],
              defaultEffort: m.defaultEffort ?? null,
              /** `capabilities.max_attachments_count`; 0 when undeclared. */
              maxAttachments: m.maxAttachments ?? 0,
              reasoningSummary: m.reasoningSummary ?? null,
              enabled: prefs.enabledIds[m.id] !== false,
              imageMode: prefs.imageModes[m.id] ?? 'auto',
            })),
            preferMaximumContext: prefs.preferMaximumContext,
            activeCount: filterByEnabled(fresh.models, prefs.enabledIds).length,
            totalCount: fresh.models.length,
            /** Which namespace a save will address; the card shows it on failure. */
            settingsNs,
          }, 'application/json');
        } catch (error) { send(response, 500, { error: error.message }, 'application/json'); }
      },
    }), `mm-minimax: GET ${resolved.modelsRoute}`);

    /**
     * The authoritative settings write.
     *
     * Registered under `webServer` ALONE (never `inject(['webServer','settings'])`)
     * so the route exists whether or not a settings service is served: a
     * service-absent 503 is then a real, readable answer instead of a 404 the
     * card would mistake for "no such route".
     *
     * `settings.mutate()` resolving is not evidence the value landed on the 0.2
     * line, so the document is re-read and deep-compared before reporting
     * success.
     */
    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: resolved.saveRoute,
      handler: async (request, response) => {
        if (!guard('POST')(request, response)) return;
        let body = '';
        try {
          for await (const chunk of request) body += chunk;
        } catch { /* fall through to the empty-body branch */ }
        let posted;
        try { posted = JSON.parse(body || '{}'); } catch { send(response, 400, { error: 'body must be JSON' }, 'application/json'); return; }

        const field = posted?.field;
        if (typeof field !== 'string' || !Object.hasOwn(SAVE_FIELDS, field)) {
          send(response, 400, { error: `field must be one of ${Object.keys(SAVE_FIELDS).join(', ')}` }, 'application/json');
          return;
        }
        const settings = webCtx.get?.('settings');
        if (settings === undefined || settings === null) {
          send(response, 503, { error: 'settings service unavailable to this fiber' }, 'application/json');
          return;
        }
        try {
          const rows = settings.describe();
          const row = findSettingsRow(rows, [settingsNs, FALLBACK_NS]);
          if (row === undefined) {
            send(response, 503, { error: `${settingsNs}/${FALLBACK_NS} namespace missing from describe(); known: ${rows.map((e) => String(e.ns)).join(', ')}` }, 'application/json');
            return;
          }
          const ns = String(row.ns);
          await settings.mutate(ns, [{ op: 'set', path: [field], value: posted.value }], void 0);
          const readBack = unwrapVolatile(settings.describe().find((e) => String(e.ns) === row.ns)?.value?.[field]);
          if (JSON.stringify(readBack) !== JSON.stringify(posted.value)) {
            send(response, 200, { ok: false, errorName: 'read-back-mismatch', error: 'settings.mutate returned but the value did not land', value: posted.value, readBack }, 'application/json');
            return;
          }
          refreshPicker();
          send(response, 200, { ok: true, value: readBack }, 'application/json');
        } catch (error) {
          send(response, 500, { ok: false, errorName: error?.name ?? 'unknown', error: String(error?.message ?? error) }, 'application/json');
        }
      },
    }), `mm-minimax: POST ${resolved.saveRoute}`);
  });

  /**
   * Settings presentation.
   *
   * The 0.1 line called `settings.installSection(...)` to publish a namespace.
   * That method does not exist anywhere on the 0.2 line — every published
   * version from `0.2.1-rc.2` through the current `0.2.1-rc.5` exports only
   * `SettingsForms` with `configure / describe / update / replace / mutate /
   * write`, so the call was dead code that never ran past its own guard.
   *
   * What actually publishes the namespace is the Loader: `describe()` walks
   * `configEditor.configuration()` and reports every entry whose Config has at
   * least one volatile field, under `ns: entry.options.id`. This plugin's three
   * switches are all volatile, so the namespace appears with no call at all.
   *
   * `configure({ auto: false })` is still worth doing: it turns off the generic
   * auto-generated form for this entry, so the settings page shows this plugin's
   * own card instead of a second, schema-derived copy of the same three fields.
   * `owner` must be the plugin's own fiber — the host keys presentations on it
   * and throws `Settings presentation is already configured` on a second call
   * from the same fiber.
   */
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (settings === undefined || typeof settings.configure !== 'function') {
      ctx.logger?.warn?.('mm-minimax: host settings service does not accept a presentation; the auto-generated form stays on');
      return;
    }
    settingsCtx.effect(
      () => settings.configure({ auto: false }, ctx.fiber),
      'mm-minimax: settings presentation',
    );
  });
}

/** Self-contained panel: no build step, no framework. */
function renderPanel(resolved) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>MiniMax Code</title><style>
body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:18px;color:#e8e8ea;background:#1d1e22}
h1{font-size:16px;margin:0 0 12px}
.grid{display:flex;gap:12px;flex-wrap:wrap}
.card{flex:1 1 220px;border:1px solid #33353c;border-radius:10px;padding:14px;background:#24262b}
.big{font-size:30px;font-weight:600}
.muted{color:#9aa0a6;font-size:12px}
button{margin-top:10px;padding:8px 14px;border-radius:8px;border:0;background:#3b6ef6;color:#fff;cursor:pointer}
button[disabled]{background:#3a3d45;color:#8b8f96;cursor:default}
table{border-collapse:collapse;margin-top:8px;font-size:12px}
td,th{border:1px solid #33353c;padding:4px 8px;text-align:left}
.err{color:#ff8a80;font-size:12px}
</style></head><body>
<h1>MiniMax Code</h1>
<div id="root" class="grid"></div>
<script>
const S=${JSON.stringify(resolved.statusRoute)}, C=${JSON.stringify(resolved.claimRoute)};
const get=(u)=>fetch(u,{headers:{accept:'application/json'}}).then(r=>r.json());
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function paint(){
  const root=document.getElementById('root');
  let d;
  try{ d=await get(S); }catch(e){ root.innerHTML='<div class="card err">读取失败：'+esc(e.message)+'</div>'; return; }
  const parts=[];
  const p=d.points;
  parts.push('<div class="card"><div class="muted">积分余额</div><div class="big">'+(p?p.remaining.toFixed(2):'—')+'</div>'+
    (p?'<div class="muted">已用 '+p.consumed.toFixed(2)+' / 授予 '+p.granted.toFixed(2)+'</div>':'')+'</div>');
  const s=d.signin;
  const btn='<button id="ck">'+(s&&s.claimedToday?'已签到 · 重新核对':'立即签到（+'+(s?s.todayPoints:0)+'）')+'</button>';
  parts.push('<div class="card"><div class="muted">每日签到</div><div class="big">'+(s?(s.claimedToday?'已领':'待领'):'—')+'</div>'+btn+'</div>');
  parts.push('<div class="card"><div class="muted">账号</div><div>'+(d.signedIn?'已登录':'未登录')+'</div>'+
    '<div class="muted">'+(d.expiresAtMs?('token 到期 '+new Date(d.expiresAtMs).toLocaleString()):'')+'</div>'+
    (function(){ const r=d.selfRenewal; if(!r) return '';
      if(!r.hasRefreshToken) return '<div class="err">缺少 refreshToken，需在 MiniMax Code 中重新登录</div>';
      if(r.blocked) return '<div class="err">自动续期暂停，'+new Date(r.blockedUntil).toLocaleTimeString()+' 后重试</div>';
      return '<div class="muted">自动续期已启用（'+Math.round(r.marginMs/60000)+' 分钟前续期，无需打开 MiniMax Code）</div>'; })()+'</div>');
  const mm=d.membership;
  parts.push('<div class="card"><div class="muted">订阅额度</div><div class="big">'+(mm&&mm.ok?esc(mm.planName||(mm.hasTokenPlan?'倍用量套餐':'未订阅')):'—')+'</div>'+
    (mm&&mm.ok?('<div class="muted">倍用量 '+(mm.multiplier===null||mm.multiplier===undefined?'接口未返回':(mm.multiplier+'x'))+'</div>'+
      '<div class="muted">额度余额 '+(mm.remaining===null||mm.remaining===undefined?'—':mm.remaining.toFixed(2))+'</div>'+
      (mm.expiresAtMs?('<div class="muted">到期 '+new Date(mm.expiresAtMs).toLocaleString()+'</div>'):'')):'')+'</div>');
  root.innerHTML=parts.join('');
  const t=document.createElement('table');
  t.innerHTML='<tr><th>模型</th><th>上下文</th><th>输出</th><th>图像</th><th>思考档位</th><th>附件</th></tr>'+
    (d.models||[]).map(m=>'<tr><td>'+esc(m.name)+'</td><td>'+m.context+'</td><td>'+m.maxTokens+'</td><td>'+(m.vision?'✓':'')+'</td>'+
      '<td>'+((Array.isArray(m.efforts)&&m.efforts.length?esc(m.efforts.filter(x=>x!=='default').join('/'))+(m.defaultEffort?'（默认 '+esc(m.defaultEffort)+'）':''):'—'))+'</td>'+
      '<td>'+(m.maxAttachments>0?m.maxAttachments:'—')+'</td></tr>').join('');
  const wrap=document.createElement('div'); wrap.className='card';
  wrap.appendChild(t);
  const dt=d.desktop;
  wrap.insertAdjacentHTML('afterbegin','<div class="muted">模型（'+esc(d.modelsSource||'')+
    (dt&&dt.defaultModel?'　桌面端默认 '+esc(String(dt.defaultModel).split('/').pop()):'')+
    (dt&&dt.defaultEffort?'　默认档位 '+esc(dt.defaultEffort):'')+
    (dt&&dt.defaultContextWindow?'　默认上下文 '+dt.defaultContextWindow:'')+'）</div>');
  root.appendChild(wrap);
  if(d.errors&&d.errors.length){ const e=document.createElement('div'); e.className='card';
    e.innerHTML='<div class="err">'+d.errors.map(esc).join('<br>')+'</div>'; root.appendChild(e); }
  const ck=document.getElementById('ck');
  if(ck) ck.onclick=async()=>{ ck.disabled=true; ck.textContent='签到中…';
    const snap=async()=>{ try{ return await fetch(S,{headers:{accept:'application/json'}}).then(x=>x.json()); }catch(e){ return null; } };
    const before=(await snap())?.points?.remaining;
    const r=await fetch(C,{method:'POST'}).then(x=>x.json()).catch(e=>({ok:false,error:e.message}));
    const after=(await snap())?.points?.remaining;
    const gain=(typeof before==='number'&&typeof after==='number')?after-before:0;
    const cr=(r.data&&typeof r.data.claim_result==='number')?'（claim_result='+r.data.claim_result+'）':'';
    ck.textContent=r.ok===true
      ? (gain>0.001?'成功 +'+gain.toFixed(2):'今日已签到，无新增'+cr)
      : ('失败：'+(r.error||''));
    setTimeout(paint,1200); };
}
paint();
setInterval(paint,30000);
</script></body></html>`;
}
