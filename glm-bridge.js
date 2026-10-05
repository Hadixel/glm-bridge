#!/usr/bin/env node
/*
 * glm-bridge — OpenAI + Anthropic compatible local bridge for Z.ai GLM,
 * backed by the ZCode desktop subscription (start plan, GLM-5.3-Flash).
 *
 * It drives ZCode's own agent CLI (zcode.cjs app-server --stdio) over the
 * official ZCode Protocol and calls `workspace/generateText`, which returns
 * {text, toolCalls, finishReason, usage} — a raw completion primitive.
 * Auth (JWT) and the per-request Aliyun captcha header are supplied by us,
 * impersonating the desktop host.
 *
 * Endpoints (all accept Bearer auth):
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions   (OpenAI, stream supported)
 *   POST /v1/messages           (Anthropic, stream supported)
 *   POST /v1/messages/count_tokens (Anthropic compat, estimate)
 *
 * Env:
 *   GLM_BRIDGE_PORT   default 3010
 *   GLM_BRIDGE_KEY    default auto-generated into config.json
 *   GLM_BRIDGE_CLI    override path to zcode.cjs
 *   GLM_BRIDGE_WORKERS        CLI processes per account (default 4; 1 = old behaviour)
 *   GLM_BRIDGE_WARM           workers kept warm per account (default 2)
 *   GLM_BRIDGE_RETRIES        transient-error retries per request (default 8)
 *   GLM_BRIDGE_QUEUE_TIMEOUT_MS  max wait for a free worker (default 240000)
 *   GLM_BRIDGE_TIMEOUT_MS     max upstream time for one generation (default 300000)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync, execFile } = require('child_process');

// ---------------------------------------------------------------- config ----
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
// Mutable state (key, tokens, logs) lives in STATE_DIR, which is the install dir
// unless GLM_BRIDGE_HOME overrides it. Shipped assets always come from the
// directory holding this script, so relocating state never breaks them.
const STATE_DIR = process.env.GLM_BRIDGE_HOME
  ? path.resolve(process.env.GLM_BRIDGE_HOME)
  : __dirname;
const ASSET_DIR = __dirname;
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const TOKENS_PATH = path.join(STATE_DIR, 'tokens.json');
const CACHE_PATH = path.join(STATE_DIR, 'account-revision.json');
const PID_PATH = path.join(STATE_DIR, 'bridge.pid');
const LOG_PATH = path.join(STATE_DIR, 'bridge.log');
const TRAY_PID_PATH = path.join(STATE_DIR, 'tray.pid');
const ACCOUNTS_PATH = path.join(STATE_DIR, 'accounts.json');
// Each ZCode account is a ZCODE_DATA_BASE_DIR; the CLI resolves credentials at
// <dir>/.zcode/v2/credentials.json. The first account ("main") uses $HOME, so
// existing single-account installs keep working unchanged. Multiple accounts
// each carry their own 100M/day start plan — the bridge rotates on quota.
let accountsCache = null;
function loadAccounts() {
  // Called many times per request; re-reading+parsing the file each time was
  // pure overhead. External edits (glm-bridge use/login) are picked up <2s.
  if (accountsCache && Date.now() - accountsCache.at < 1500) return accountsCache.data;
  let a = null;
  try { a = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')); } catch { /* first run */ }
  if (!a || !Array.isArray(a.accounts) || !a.accounts.length) {
    a = { active: 'main', accounts: [{ name: 'main', dir: HOME, addedAt: Date.now() }] };
  }
  const now = Date.now();
  let changed = false;
  for (const acc of a.accounts) {
    if (acc.exhaustedUntil && acc.exhaustedUntil <= now) {
      delete acc.exhaustedUntil;
      changed = true;
    }
    if (acc.quotaEmptyUntil && acc.quotaEmptyUntil <= now) {
      delete acc.quotaEmptyUntil;
      changed = true;
    }
  }
  if (!a.accounts.some(x => x.name === a.active)) {
    a.active = a.accounts[0].name;
    changed = true;
  }
  accountsCache = { at: Date.now(), data: a };
  if (changed) {
    try { saveAccounts(a); } catch {}
  }
  return a;
}
function saveAccounts(a) {
  const body = JSON.stringify(a, null, 2);
  const tmp = ACCOUNTS_PATH + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, ACCOUNTS_PATH);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(ACCOUNTS_PATH, body);
  }
  accountsCache = { at: Date.now(), data: a };
}
function activeAccount() {
  const a = loadAccounts();
  return a.accounts.find(x => x.name === a.active) || a.accounts[0];
}
function accountCredFile(acc) {
  const dir = acc ? acc.dir : activeAccount().dir;
  return path.join(dir, '.zcode', 'v2', 'credentials.json');
}
function getUsableAccounts() {
  const a = loadAccounts();
  const now = Date.now();
  return a.accounts.filter(x => {
    if (!fs.existsSync(accountCredFile(x))) return false;
    if (x.exhaustedUntil && x.exhaustedUntil > now) return false;
    if (x.quotaEmptyUntil && x.quotaEmptyUntil > now) return false;
    return true;
  });
}
function markAccountExhausted(name, reason) {
  const a = loadAccounts();
  const acc = a.accounts.find(x => x.name === name);
  if (!acc) return;
  acc.exhaustedUntil = nextRenewalMs();
  saveAccounts(a);
  log(`account "${name}" paused until daily quota resets (${reason})`);
}
function markAccountEmpty(name, reason) {
  const a = loadAccounts();
  const acc = a.accounts.find(x => x.name === name);
  if (!acc) return;
  acc.quotaEmptyUntil = nextRenewalMs();
  saveAccounts(a);
  log(`account "${name}" marked empty until renewal (${reason})`);
}
function clearAccountExhaustion(name) {
  try {
    const a = loadAccounts();
    const acc = a.accounts.find(x => x.name === name);
    if (acc && (acc.exhaustedUntil || acc.quotaEmptyUntil)) {
      delete acc.exhaustedUntil;
      delete acc.quotaEmptyUntil;
      saveAccounts(a);
    }
  } catch {}
}

// Per-model capacity check for smart routing: an account is usable for a
// given model if ANY bucket covering that model still has tokens left
// (e.g. hadij: drained 100M Flash pool but leftover GLM-5.3 daily tokens).
const modelBlocks = new Map();   // "account|model" -> blocked until (ms)
function blockModel(accName, model, ms) { modelBlocks.set(accName + '|' + model, Date.now() + ms); }
function accountHasModelTokens(accName, requestedModel) {
  const until = modelBlocks.get(accName + '|' + requestedModel);
  if (until && until > Date.now()) return false;
  const plan = accountPlans.get(accName);
  if (!plan || plan.err) return true;  // unknown -> let it try
  const mq = plan.modelQuotas || {};
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(requestedModel);
  for (const [m, v] of Object.entries(mq)) {
    const mv = norm(m);
    if (mv === want || mv.startsWith(want) || want.startsWith(mv)) {
      return (v.remaining || 0) > 0;
    }
  }
  return Object.values(mq).some(v => (v.remaining || 0) > 0);
}


function nextRenewalMs() {
  const parts = String(process.env.GLM_BRIDGE_CLAIM_AT || '19:30').split(':');
  const hh = Number.isFinite(Number(parts[0])) ? Number(parts[0]) : 19;
  const mm = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 30;
  const next = new Date();
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= Date.now() + 5 * 60_000) next.setDate(next.getDate() + 1);
  return next.getTime() + 10 * 60_000;  // renewal + claim grace
}
function rotateAccount(reason) {
  const a = loadAccounts();
  const cur = a.accounts.find(x => x.name === a.active);
  if (cur) cur.exhaustedUntil = nextRenewalMs();
  const usable = getUsableAccounts().filter(x => x.name !== (cur ? cur.name : ''));
  if (!usable.length) {
    saveAccounts(a);
    log(`quota exhausted (${reason}) and no other account is usable`);
    return false;
  }
  a.active = usable[0].name;
  saveAccounts(a);
  log(`rotated active account to "${usable[0].name}" (${reason})`);
  return true;
}
// ZCode keeps its CLI data in <dataBaseDir>/.zcode on every platform
const zcodeDir = (acc) => path.join((acc || activeAccount()).dir, '.zcode');
const credPath = (acc) => path.join(zcodeDir(acc), 'v2', 'credentials.json');
const workspace = (acc) => path.join(STATE_DIR, 'workspace', (acc || activeAccount()).name);
const MINT_SCRIPT = path.join(ASSET_DIR, 'mint-captcha.js');
const SYSBLOCKS_PATH = path.join(ASSET_DIR, 'sysblocks.json');
const APPIMAGE = (() => {
  try {
    if (IS_WIN) {
      // Windows installer: %LOCALAPPDATA%\Programs\ZCode\ZCode.exe is an
      // Electron app; resources live beside it.
      const cands = [
        path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'ZCode'),
        path.join(HOME, 'AppData', 'Local', 'ZCode'),
      ];
      for (const dir of cands) {
        const p = path.join(dir, 'resources', 'glm', 'zcode.cjs');
        if (fs.existsSync(p)) return p;
      }
      return null;
    }
    return fs.readdirSync(path.join(HOME, 'Applications'))
      .filter(f => /^ZCode-.*\.AppImage$/.test(f))
      .map(f => path.join(HOME, 'Applications', f))
      .sort()
      .pop() || null;
  } catch { return null; }
})();

fs.mkdirSync(STATE_DIR, { recursive: true });

let logBuf = [];
let logTimer = null;
function flushLog(sync = false) {
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  if (!logBuf.length) return;
  const data = logBuf.join('');
  logBuf = [];
  if (sync) { try { fs.appendFileSync(LOG_PATH, data); } catch { /* ignore */ } }
  else fs.appendFile(LOG_PATH, data, () => {});
}
function rotateLogIfBig() {
  try { if (fs.statSync(LOG_PATH).size > 8 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch { /* none yet */ }
}
// Never block the event loop on disk for every log line (it runs several
// times per request, on the same thread that serves every session).
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  logBuf.push(line);
  if (logBuf.length >= 200) flushLog();
  else if (!logTimer) { logTimer = setTimeout(() => flushLog(), 300); if (logTimer.unref) logTimer.unref(); }
  if (process.env.GLM_BRIDGE_QUIET !== '1') process.stdout.write(line);
}
process.on('exit', () => flushLog(true));

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  if (!c.key) {
    c.key = 'glm-local-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
    log('generated bridge key ->', c.key);
  }
  c.port = Number(process.env.GLM_BRIDGE_PORT || c.port || 3010);
  if (process.env.GLM_BRIDGE_KEY) c.key = process.env.GLM_BRIDGE_KEY;
  c.routing = process.env.GLM_BRIDGE_ROUTING || c.routing || 'session-pin';
  return c;
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}
let routingCache = { at: 0, mode: null };
function getRoutingMode() {
  if (process.env.GLM_BRIDGE_ROUTING) return process.env.GLM_BRIDGE_ROUTING;
  if (routingCache.mode && Date.now() - routingCache.at < 5000) return routingCache.mode;
  const cfg = loadConfig();
  routingCache = { at: Date.now(), mode: cfg.routing || 'session-pin' };
  return routingCache.mode;
}
function setRoutingMode(mode) {
  if (!['round-robin', 'fill-first', 'session-pin'].includes(mode)) {
    throw new Error('Routing mode must be "round-robin", "fill-first" or "session-pin"');
  }
  const cfg = loadConfig();
  cfg.routing = mode;
  saveConfig(cfg);
  routingCache.at = 0;
  log(`routing mode set to: ${mode}`);
  return mode;
}
const config = loadConfig();

// ------------------------------------------------------------- credentials ---
// ZCode stores credentials as enc:v1:<iv>.<tag>.<ct> (AES-256-GCM, base64url),
// key = sha256(ZCODE_CREDENTIAL_SECRET || "zcode-credential-fallback:<os>:<home>:<user>").
function decryptCredential(blob) {
  if (!blob.startsWith('enc:v1:')) return blob;
  const [ivB, tagB, ctB] = blob.slice('enc:v1:'.length).split('.');
  const b = s => Buffer.from(s, 'base64url');
  const secret = process.env.ZCODE_CREDENTIAL_SECRET
    || `zcode-credential-fallback:${os.platform()}:${HOME}:${os.userInfo().username}`;
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, b(ivB));
  d.setAuthTag(b(tagB));
  return Buffer.concat([d.update(b(ctB)), d.final()]).toString('utf8');
}

const credCache = new Map();
function loadJwt(acc) {
  if (!acc) acc = activeAccount();
  const cached = credCache.get(acc.name);
  if (cached && Date.now() - cached.at < 60_000 && cached.jwt) return cached.jwt;
  const file = accountCredFile(acc);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const jwt = decryptCredential(raw['zcodejwttoken']);
    credCache.set(acc.name, { at: Date.now(), jwt });
    return jwt;
  } catch (e) {
    return null;
  }
}
// Stable per-Z.AI-account id, read from the stored JWT subject. Two accounts
// with the same id are the same upstream login: they share one plan, one
// daily quota and one 100M offer, so a duplicate entry buys nothing.
function zaiUserId(acc) {
  const jwt = loadJwt(acc);
  if (!jwt) return null;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return payload.sub || payload.user_id || payload.uid || null;
  } catch {
    return null;
  }
}

// Which other account (if any) already holds this Z.AI login.
function duplicateOf(acc, accs) {
  const id = zaiUserId(acc);
  if (!id) return null;
  const all = accs || loadAccounts().accounts;
  return all.find(a => a.name !== acc.name && zaiUserId(a) === id) || null;
}

// Accounts are selectable by 1-based index (`use 2`) or by name (`use ha work`).
function resolveAccountRef(accs, ref) {
  const list = accs.accounts;
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const i = Number(raw) - 1;
    return i >= 0 && i < list.length ? list[i] : null;
  }
  return list.find(a => a.name === raw) || null;
}

// ----------------------------------------------------------- captcha mint ----
// One Aliyun captcha device token per pool entry; scene from ZCode client config.
const CAPTCHA = { captchaId: 'MBmzpRpV', sceneId: '11xygtvd', region: 'sgp', prefix: 'no8xfe' };
let tokens = [];
let minting = false;

function loadTokens() {
  try { tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { tokens = []; }
}
function saveTokens() {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens));
}
function nextToken() {
  if (tokens.length === 0) return null;
  const t = tokens.shift();
  saveTokens();
  if (tokens.length < 4) setImmediate(() => ensureTokens());   // keep the pool warm
  return t;
}
let mintFailStreak = 0;
let mintBlockedUntil = 0;
function ensureTokens(background = true) {
  if (minting || tokens.length >= 8) return;
  if (Date.now() < mintBlockedUntil) return;     // backing off after failed mints
  if (!fs.existsSync(MINT_SCRIPT)) { log('mint script missing:', MINT_SCRIPT); return; }
  minting = true;
  const out = path.join(STATE_DIR, `tokens-mint-${Date.now()}.json`);
  const p = spawn(process.execPath, [MINT_SCRIPT, '10', out],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...proxyEnv() } });
  // Chromium minting is CPU heavy: never let it compete with live requests.
  try { os.setPriority(p.pid, 10); } catch { /* best effort */ }
  p.stdout.on('data', d => log('[mint]', String(d).trim()));
  p.stderr.on('data', d => log('[mint:err]', String(d).trim().slice(0, 300)));
  p.on('error', e => { log('[mint:spawn]', e.message); minting = false; });
  p.on('exit', code => {
    minting = false;
    let got = 0;
    try {
      const fresh = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (Array.isArray(fresh) && fresh.length) {
        got = fresh.length;
        loadTokens();
        tokens = [...new Set([...tokens, ...fresh])];
        saveTokens();
        log(`minted ${fresh.length} captcha tokens (pool=${tokens.length})`);
      }
      fs.rmSync(out, { force: true });
    } catch (e) { log('mint merge failed:', e.message); }
    if (got) mintFailStreak = 0; else mintFailStreak++;
    if (tokens.length < 4) {
      // Failed mints used to retry every 2s forever, burning CPU on a
      // Chromium launch each time. Back off exponentially (max 10 min).
      const delay = got ? 2000 : Math.min(10 * 60_000, 4000 * 2 ** Math.min(mintFailStreak, 8));
      mintBlockedUntil = got ? 0 : Date.now() + delay;
      setTimeout(() => ensureTokens(), delay);
    }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------- quota state (loud) ------
// When upstream 1005s every account, /health and the TUI must SAY so and
// what to do (claim in the GUI / wait for renewal) instead of looking "up".
const quotaState = { lastQuotaAt: 0, lastOkAt: 0 };
const planCache = {
  at: 0,
  active: null,
  endsAt: null,
  err: null,
  quotaLeft: null,
  quotaSummary: null,
  percent: null,
  remainingTokens: 0,
  totalTokens: 0,
  balances: [],
};

function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

function getTelemetryMid(acc) {
  try {
    const dir = acc ? acc.dir : activeAccount().dir;
    const p = path.join(dir, '.zcode', 'v2', 'telemetry-state.json');
    const mid = JSON.parse(fs.readFileSync(p, 'utf8')).deviceMid;
    return typeof mid === 'string' && mid ? mid : '';
  } catch { return ''; }
}

const accountPlans = new Map();

async function refreshAccountPlan(acc) {
  if (!acc) acc = activeAccount();
  const cached = accountPlans.get(acc.name);
  if (cached && Date.now() - cached.at < 30_000) return cached;

  const res = {
    at: Date.now(),
    name: acc.name,
    active: false,
    endsAt: null,
    err: null,
    quotaLeft: null,
    quotaSummary: null,
    percent: null,
    remainingTokens: 0,
    totalTokens: 0,
    balances: [],
  };

  try {
    const jwt = loadJwt(acc);
    if (!jwt) throw new Error('no credentials');
    const mid = getTelemetryMid(acc);
    const headers = {
      authorization: 'Bearer ' + jwt,
      'user-agent': 'ZCode/3.14.4',
      'x-zcode-app-version': '3.14.4',
      'x-platform': `${process.platform}-${process.arch}`,
      'x-client-language': 'en-US',
    };
    if (mid) headers['x-device-mid'] = mid;

    const balancePath = '/api/v1/zcode-plan/billing/balance?app_version=3.14.4&platform='
      + `${process.platform}-${process.arch}`;
    let r = await httpsGet(balancePath, resolvedProxy, 10_000, headers);
    if (r.status !== 200) {
      const currentPath = '/api/v1/zcode-plan/billing/current?app_version=3.14.4&platform='
        + `${process.platform}-${process.arch}`;
      r = await httpsGet(currentPath, resolvedProxy, 10_000, headers);
    }
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const j = JSON.parse(r.body);
    const data = j.data || {};
    const plans = data.plans || [];
    const balances = data.balances || [];
    const now = Math.floor(Date.now() / 1000);

    const act = plans.find(x => String(x.status || '').toLowerCase() === 'active'
      && (!Number.isFinite(x.ends_at) || x.ends_at > now));
    res.active = !!act;
    res.endsAt = act && Number.isFinite(act.ends_at) ? act.ends_at : null;

    const activeBalances = balances.filter(b => {
      if (b.expires_at && Number.isFinite(b.expires_at) && b.expires_at <= now) return false;
      return true;
    });

    res.balances = activeBalances.map(b => {
      const total = Number(b.total_units) || 0;
      const used = Number(b.used_units) || 0;
      const remaining = Number(b.remaining_units) || 0;
      const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
      return {
        model: b.show_name || 'GLM',
        total,
        used,
        remaining,
        totalFormatted: formatTokens(total),
        remainingFormatted: formatTokens(remaining),
        percent: pct,
      };
    });

    const modelQuotas = {};
    for (const b of activeBalances) {
      const model = b.show_name || 'GLM';
      if (!modelQuotas[model]) {
        modelQuotas[model] = { model, total: 0, used: 0, remaining: 0 };
      }
      modelQuotas[model].total += Number(b.total_units) || 0;
      modelQuotas[model].used += Number(b.used_units) || 0;
      modelQuotas[model].remaining += Number(b.remaining_units) || 0;
    }
    for (const [k, v] of Object.entries(modelQuotas)) {
      v.percent = v.total > 0 ? Math.round((v.remaining / v.total) * 100) : 0;
      v.remainingFormatted = formatTokens(v.remaining);
      v.totalFormatted = formatTokens(v.total);
      v.label = `${v.remainingFormatted} / ${v.totalFormatted} (${v.percent}%)`;
    }
    res.modelQuotas = modelQuotas;

    // An account is only "empty" when EVERY bucket is drained. hadij-style
    // accounts often have a drained 100M Flash pool but leftover GLM-5.3
    // tokens — parking the whole account there wasted the remainder.
    const totalRem = activeBalances.reduce((s, b) => s + (Number(b.remaining_units) || 0), 0);
    const totalCap = activeBalances.reduce((s, b) => s + (Number(b.total_units) || 0), 0);
    const bestBucket = [...activeBalances].sort((a, b) =>
      (Number(b.remaining_units) || 0) - (Number(a.remaining_units) || 0))[0];
    const showBucket = bestBucket || activeBalances[0];

    if (showBucket) {
      const rem = Number(showBucket.remaining_units) || 0;
      const pct = totalCap > 0 ? Math.round((totalRem / totalCap) * 100) : 0;
      res.remainingTokens = totalRem;
      res.totalTokens = totalCap;
      res.percent = pct;
      res.quotaLeft = `${formatTokens(totalRem)} (${pct}%)`;

      const modelParts = Object.values(modelQuotas)
        .filter(m => m.remaining > 0)
        .map(m => `${m.model.replace(/^GLM-/, '')}: ${m.remainingFormatted}/${m.totalFormatted}`);
      res.quotaSummary = modelParts.length ? modelParts.join(' · ') : `${formatTokens(totalRem)} left`;

      if (totalRem <= 0) {
        markAccountEmpty(acc.name, 'all balances drained');
      } else {
        clearAccountExhaustion(acc.name);
      }
    } else {
      res.quotaLeft = act ? 'active' : null;
    }
  } catch (e) {
    res.err = e.message;
  }

  accountPlans.set(acc.name, res);
  return res;
}

async function refreshPlan() {
  const allAccounts = loadAccounts().accounts.filter(a => fs.existsSync(accountCredFile(a)));
  for (const a of allAccounts) {
    await refreshAccountPlan(a).catch(() => {});
  }

  let totalRemaining = 0;
  let totalCap = 0;
  const summaries = [];
  const activePlan = accountPlans.get(activeAccount().name);

  for (const a of allAccounts) {
    const p = accountPlans.get(a.name);
    if (p && !p.err) {
      totalRemaining += p.remainingTokens;
      totalCap += p.totalTokens;
      if (p.quotaLeft) summaries.push(`${a.name}: ${p.quotaLeft}`);
    }
  }

  planCache.at = Date.now();
  planCache.active = allAccounts.some(a => accountPlans.get(a.name)?.active);
  planCache.remainingTokens = totalRemaining;
  planCache.totalTokens = totalCap;
  planCache.percent = totalCap > 0 ? Math.round((totalRemaining / totalCap) * 100) : 0;
  planCache.balances = activePlan ? activePlan.balances : [];
  const combinedModelQuotas = {};
  for (const a of allAccounts) {
    const p = accountPlans.get(a.name);
    if (p && p.modelQuotas) {
      for (const [mName, mData] of Object.entries(p.modelQuotas)) {
        if (!combinedModelQuotas[mName]) {
          combinedModelQuotas[mName] = { model: mName, total: 0, used: 0, remaining: 0 };
        }
        combinedModelQuotas[mName].total += mData.total;
        combinedModelQuotas[mName].used += mData.used;
        combinedModelQuotas[mName].remaining += mData.remaining;
      }
    }
  }

  for (const [k, v] of Object.entries(combinedModelQuotas)) {
    v.percent = v.total > 0 ? Math.round((v.remaining / v.total) * 100) : 0;
    v.remainingFormatted = formatTokens(v.remaining);
    v.totalFormatted = formatTokens(v.total);
    v.label = `${v.remainingFormatted} / ${v.totalFormatted} (${v.percent}%)`;
  }
  planCache.modelQuotas = combinedModelQuotas;

  const modelParts = Object.values(combinedModelQuotas).map(m =>
    `${m.model.replace(/^GLM-/, '')}: ${m.remainingFormatted}/${m.totalFormatted}`
  );

  if (allAccounts.length > 1) {
    planCache.quotaLeft = `${formatTokens(totalRemaining)} (${planCache.percent}%)`;
    planCache.quotaSummary = modelParts.length ? modelParts.join(' · ') : summaries.join(' · ');
  } else if (activePlan) {
    planCache.quotaLeft = activePlan.quotaLeft;
    planCache.quotaSummary = modelParts.length ? modelParts.join(' · ') : activePlan.quotaSummary;
  }
  return planCache;
}
function markQuotaDrained() {
  if (quotaState.lastQuotaAt < Date.now() - 1000) {
    quotaState.lastQuotaAt = Date.now();
    refreshPlan().catch(() => {});  // populate plan info in the background
  }
}

// ------------------------------------------------------- connectivity ------
// The local network may have no direct internet (VPN off), which made every
// upstream call hang until the CLI gave up. We probe direct first, then fall
// back to a local proxy, and give the result to the CLI child via env
// (Node honours HTTPS_PROXY when --use-env-proxy is on, which we inject).
function getSystemProxy() {
  const envProxy = process.env.GLM_BRIDGE_PROXY
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return envProxy;

  if (process.platform === 'linux') {
    try {
      const mode = execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'],
        { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/'/g, '');
      if (mode === 'manual') {
        const host = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/'/g, '');
        const port = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (host && port && port !== '0') return `http://${host}:${port}`;
        const socksHost = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/'/g, '');
        const socksPort = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port'],
          { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (socksHost && socksPort && socksPort !== '0') return `socks5://${socksHost}:${socksPort}`;
      }
    } catch {}
  } else if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m && m[1]) {
        const server = m[1];
        return server.includes('://') ? server : `http://${server}`;
      }
    } catch {}
  } else if (process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
      const httpEnabled = /HTTPEnable\s*:\s*1/.test(out);
      const hostMatch = out.match(/HTTPProxy\s*:\s*(\S+)/);
      const portMatch = out.match(/HTTPPort\s*:\s*(\d+)/);
      if (httpEnabled && hostMatch && portMatch) {
        return `http://${hostMatch[1]}:${portMatch[1]}`;
      }
    } catch {}
  }
  return null;
}

function getProxyCandidates() {
  if (process.env.GLM_BRIDGE_PROXY !== undefined) {
    return [process.env.GLM_BRIDGE_PROXY].filter(Boolean);
  }
  const cands = [];
  const sys = getSystemProxy();
  if (sys) cands.push(sys);
  const envProxies = [
    process.env.HTTPS_PROXY, process.env.https_proxy,
    process.env.ALL_PROXY, process.env.all_proxy,
    process.env.HTTP_PROXY, process.env.http_proxy,
  ].filter(Boolean);
  cands.push(...envProxies);
  cands.push(
    'http://127.0.0.1:10809', 'http://127.0.0.1:7890', 'http://127.0.0.1:8118',
    'http://127.0.0.1:20171', 'http://127.0.0.1:10808', 'http://127.0.0.1:1080'
  );
  return [...new Set(cands)];
}
const PROBE_HOST = 'zcode.z.ai';
const PROBE_PATH = '/api/v1/zcode-plan/billing/current?app_version=3.14.4';
let resolvedProxy;      // undefined = unprobed, null = direct, string = proxy url
let resolvedProxyAt = 0;

// Minimal HTTPS GET that can tunnel through an http proxy (CONNECT).
function httpsGet(path, proxy, timeoutMs = 10000, extraHeaders = {}) {
  // curl does the CONNECT tunneling for us and is present on Linux, macOS and
  // Windows 10+. A hand-rolled TLS tunnel was tried and hung instead of failing.
  return new Promise(resolve => {
    const secs = Math.max(2, Math.ceil(timeoutMs / 1000));
    const args = ['-sS', '-m', String(secs), '-w', '\n__CODE__%{http_code}'];
    if (proxy) args.push('-x', proxy);
    for (const [k, v] of Object.entries(extraHeaders)) args.push('-H', `${k}: ${v}`);
    args.push(`https://${PROBE_HOST}${path}`);
    execFile('curl', args, { timeout: (secs + 3) * 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const s = String(stdout || '');
        const i = s.lastIndexOf('\n__CODE__');
        if (i < 0) return resolve({ status: 0, body: '' });
        resolve({ status: Number(s.slice(i + 9)) || 0, body: s.slice(0, i) });
      });
  });
}

async function resolveProxy(force = false) {
  if (!force && resolvedProxy !== undefined && Date.now() - resolvedProxyAt < 5 * 60_000) return resolvedProxy;
  const direct = await httpsGet(PROBE_PATH, null).catch(() => ({ status: 0 }));
  if (direct.status >= 200 && direct.status < 500) {
    if (resolvedProxy !== null && resolvedProxy !== undefined) log('connectivity: direct route OK');
    resolvedProxy = null;
    resolvedProxyAt = Date.now();
    return resolvedProxy;
  }
  for (const p of getProxyCandidates()) {
    const r = await httpsGet(PROBE_PATH, p).catch(() => ({ status: 0 }));
    if (r.status >= 200 && r.status < 500) {
      log(`connectivity: direct blocked, using proxy ${p} (upstream ${r.status})`);
      resolvedProxy = p;
      resolvedProxyAt = Date.now();
      return resolvedProxy;
    }
  }
  log('connectivity: no working route (direct and proxies failed)');
  // Keep a previously working proxy instead of flapping: flipping the route on
  // one failed probe used to respawn every CLI and kill in-flight requests.
  if (resolvedProxy === undefined) resolvedProxy = null;
  resolvedProxyAt = Date.now();
  return resolvedProxy;
}

// Env handed to the CLI child and to minting so their HTTP goes via the proxy.
function proxyEnv() {
  const p = resolvedProxy;
  if (!p) return {};
  return {
    HTTPS_PROXY: p, HTTP_PROXY: p, https_proxy: p, http_proxy: p,
    ALL_PROXY: p, all_proxy: p,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    // Node only applies proxy env to global clients when this flag is on.
    // NB: do not "dedupe" by testing the incoming value against the flag we
    // are adding — that filters out the flag itself and yields an empty string.
    NODE_OPTIONS: (() => {
      const cur = (process.env.NODE_OPTIONS || '').trim();
      if (cur.includes('--use-env-proxy')) return cur;
      return cur ? `${cur} --use-env-proxy` : '--use-env-proxy';
    })(),
    GLM_BRIDGE_PROXY: p,
    MINT_PROXY: p,
  };
}

// The upstream decides whether model requests need a captcha token at all
// (`configs.captcha.skip_model_request`). When it is true we must not mint:
// minting needs Chromium, can fail, and burning tokens we do not need leaves
// the bridge refusing requests (HTTP 503 from 9router) once the pool drains.
// The policy is cached for a few minutes and refreshed in the background.
const CAPTCHA_CONFIG_URL = `https://zcode.z.ai/api/v1/client/configs?app_version=${encodeURIComponent(process.env.ZCODE_APP_VERSION || '3.14.4')}&platform=${IS_WIN ? 'win32-x64' : 'linux-x64'}`;
let captchaPolicy = { at: 0, required: null };

async function captchaPolicyRequired() {
  if (captchaPolicy.required !== null && Date.now() - captchaPolicy.at < 5 * 60_000) {
    return captchaPolicy.required;
  }
  try {
    const url = new URL(CAPTCHA_CONFIG_URL);
    const r = await httpsGet(url.pathname + url.search, resolvedProxy, 10000,
      { authorization: 'Bearer ' + loadJwt() });
    if (!r.status) throw new Error('unreachable');
    const j = JSON.parse(r.body || '{}');
    const c = j && j.data && j.data.configs && j.data.configs.captcha;
    const required = !!(c && c.enabled !== false && c.skip_model_request !== true);
    if (required !== captchaPolicy.required) {
      log(`captcha policy changed -> ${required ? 'required (minting enabled)' : 'not required (skip_model_request)'}`);
    }
    captchaPolicy = { at: Date.now(), required };
    return required;
  } catch (e) {
    if (captchaPolicy.required === null) {
      log('captcha policy unknown, assuming not required:', e.message);
      captchaPolicy = { at: Date.now(), required: false };
    }
    return captchaPolicy.required;
  }
}

// Called when the upstream rejects a request as captcha-blocked, so we can
// recover even if the config endpoint said otherwise.
function forceCaptchaRequired(reason) {
  if (captchaPolicy.required !== true) log('captcha forced required:', reason);
  captchaPolicy = { at: Date.now(), required: true };
  ensureTokens();
}

async function waitForToken(ms) {
  let tok = nextToken();
  if (tok) return tok;
  ensureTokens();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(500);   // async: never blocks the HTTP server
    loadTokens();
    tok = nextToken();
    if (tok) return tok;
  }
  return null;
}

async function captchaHeader() {
  if (!(await captchaPolicyRequired())) return {};   // upstream does not want one
  const tok = await waitForToken(90_000);   // mint takes ~60s when pool is cold
  if (!tok) return null;                             // required but we have none
  const param = Buffer.from(JSON.stringify({
    captchaId: CAPTCHA.captchaId,
    sceneId: CAPTCHA.sceneId,
    isSign: true,
    securityToken: tok,
  })).toString('base64');
  return { 'X-Aliyun-Captcha-Verify-Param': param, 'X-Aliyun-Captcha-Verify-Region': CAPTCHA.region };
}

// ------------------------------------------------------ builtin + revision ---
function findBuiltinFile() {
  const roots = [path.join(zcodeDir(), 'v2', 'runtime', 'provider')];
  const hits = [];
  for (const root of roots) {
    try {
      const walk = (dir, depth) => {
        if (depth > 6) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (e.name === 'zcode-builtin.json') hits.push(p);
        }
      };
      walk(root, 0);
    } catch { /* no runtime dir */ }
  }
  hits.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  if (hits[0]) return hits[0];
  const cliRoot = resolveCliRoot();
  const fallback = cliRoot && path.join(path.dirname(cliRoot), 'config', 'provider', 'zcode-builtin.json');
  const fallbackWin = cliRoot && path.join(path.dirname(cliRoot), '..', 'config', 'provider', 'zcode-builtin.json');
  if (fallback && fs.existsSync(fallback)) return fallback;
  if (fallbackWin && fs.existsSync(fallbackWin)) return fallbackWin;
  // Windows: desktop exe at <root>/ZCode.exe, resources at <root>/resources/glm/...
  if (cliRoot && IS_WIN) {
    const winPath = path.join(path.dirname(path.dirname(cliRoot)), 'config', 'provider', 'zcode-builtin.json');
    if (fs.existsSync(winPath)) return winPath;
  }
  return null;
}

function builtinRevisionFor(file) {
  const rev = JSON.parse(fs.readFileSync(file, 'utf8')).revision;
  const h = crypto.createHash('sha256').update(path.resolve(file)).digest('hex');
  return `zcode-builtin:${rev}:${h}`;
}

function statesFor(providers) {
  const states = {};
  let currentGiven = false;
  for (const p of Object.keys(providers)) {
    const acc = providers[p] && providers[p].access;
    const entitled = !!(acc && acc.type === 'zhipu-account' && acc.entitled);
    if (!entitled) {
      states[p] = { availability: 'unavailable', entitled: false, unavailableReason: 'not-entitled' };
    } else {
      const isCurrent = !currentGiven && /start-plan$/.test(p);
      if (isCurrent) currentGiven = true;
      states[p] = { availability: 'available', entitled: true, current: isCurrent };
    }
  }
  // guarantee every entitled provider has a boolean current (protocol requires it)
  for (const [p, s] of Object.entries(states)) {
    if (s.entitled && typeof s.current !== 'boolean') s.current = false;
  }
  return states;
}

function ensureStartPlanModels(providers, inner) {
  const sp = providers['account:zai-start-plan'];
  if (sp) {
    const list = Array.isArray(sp.builtinModelIds) ? sp.builtinModelIds : [];
    if (!list.includes('GLM-5.3')) {
      sp.builtinModelIds = ['GLM-5.3', ...list.filter(m => m !== 'GLM-5.3')];
    }
  }
  if (inner && Array.isArray(inner[1])) {
    for (const p of inner[1]) {
      if (p.providerId === 'account:zai-start-plan' && p.config) {
        const list = Array.isArray(p.config.builtinModelIds) ? p.config.builtinModelIds : [];
        if (!list.includes('GLM-5.3')) {
          p.config.builtinModelIds = ['GLM-5.3', ...list.filter(m => m !== 'GLM-5.3')];
        }
      }
    }
  }
}

function loadAccountRevision(builtinFile) {
  const computed = builtinRevisionFor(builtinFile);
  // 1) newest desktop log line (desktop host is the source of truth)
  try {
    const logDir = path.join(zcodeDir(), 'v2', 'logs');
    if (!fs.existsSync(logDir)) throw new Error('logs dir does not exist');
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
    for (const f of files) {
      const txt = fs.readFileSync(path.join(logDir, f), 'utf8');
      const re = /receivedRevision":"(account:\[(?:\\.|[^"\\])+)"/g;
      let m, last = null;
      while ((m = re.exec(txt))) last = m[1];
      if (last) {
        const decoded = JSON.parse('"' + last + '"'); // unescape \" etc.
        const inner = JSON.parse(decoded.slice('account:'.length));
        inner[0] = computed;
        const revision = 'account:' + JSON.stringify(inner);
        const providers = {};
        for (const p of inner[1]) providers[p.providerId] = p.config;
        ensureStartPlanModels(providers, inner);
        const out = { revision, basedOnZCodeBuiltinRevision: computed, providers, states: statesFor(providers) };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(out, null, 2));
        log('account revision parsed from desktop log');
        return out;
      }
    }
  } catch (e) { log('log parse failed:', e.message); }
  // 2) cache
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    cached.basedOnZCodeBuiltinRevision = computed;
    const inner = JSON.parse(cached.revision.slice(cached.revision.indexOf(':') + 1));
    inner[0] = computed;
    cached.revision = 'account:' + JSON.stringify(inner);
    ensureStartPlanModels(cached.providers, inner);
    cached.states = statesFor(cached.providers);
    log('account revision loaded from cache');
    return cached;
  } catch (e) { log('cache load failed:', e.message); }
  // 3) last resort: derive from builtin provider rules; assume start-plan entitled
  try {
    const builtin = JSON.parse(fs.readFileSync(builtinFile, 'utf8'));
    const rules = builtin.config.providerConfigRules.providerRules || [];
    const providers = {};
    for (const r of rules) {
      const c = r.config || {};
      // protocol accepts only {type, entitled} on account access (no mode/accountType)
      const access = { type: 'zhipu-account', entitled: r.providerId === 'account:zai-start-plan' };
      providers[r.providerId] = { access, builtinModelIds: c.builtinModelIds };
    }
    const inner = [computed, Object.entries(providers).map(([providerId, config]) => ({ providerId, config }))];
    ensureStartPlanModels(providers, inner);
    const out = { revision: 'account:' + JSON.stringify(inner), basedOnZCodeBuiltinRevision: computed, providers, states: statesFor(providers) };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(out, null, 2));
    log('account revision derived from builtin rules');
    return out;
  } catch (e) { log('builtin derive failed:', e.message); }
  throw new Error('unable to build account revision');
}

// ------------------------------------------------------------- CLI resolve ---
function findMountedCli() {
  try {
    if (IS_WIN) return null; // Windows: no AppImage mounts; installer-provided CLI
    const mounts = fs.readdirSync('/tmp').filter(d => d.startsWith('.mount_ZCode'));
    for (const m of mounts.sort().reverse()) {
      const p = path.join('/tmp', m, 'resources', 'glm', 'zcode.cjs');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}
function resolveCliRoot() {
  if (process.env.GLM_BRIDGE_CLI) return process.env.GLM_BRIDGE_CLI;
  // Prefer our own extracted copy: it means the ZCode desktop can be closed
  // and the /tmp AppImage mount can disappear without breaking the bridge.
  const extracted = path.join(ASSET_DIR, 'squashfs-root', 'resources', 'glm', 'zcode.cjs');
  if (fs.existsSync(extracted)) return extracted;
  if (IS_WIN) {
    // Windows: ZCode desktop (Electron) ships resources beside the exe
    if (APPIMAGE) return APPIMAGE;
    log('Windows: zcode.cjs not found under %LOCALAPPDATA%\\Programs\\ZCode');
    return null;
  }
  const mounted = findMountedCli();
  if (mounted) {
    log('using live AppImage mount, extracting a private copy for offline use');
    try {
      execFileSync(APPIMAGE || mounted, ['--appimage-extract'], { cwd: ASSET_DIR, stdio: 'pipe', timeout: 300_000 });
    } catch (e) { log('extract failed:', e.message.slice(0, 200)); }
    if (fs.existsSync(extracted)) return extracted;
    return mounted;
  }
  if (APPIMAGE) {
    log('no AppImage mount, extracting once ->', ASSET_DIR);
    try {
      execFileSync(APPIMAGE, ['--appimage-extract'], { cwd: ASSET_DIR, stdio: 'pipe', timeout: 300_000 });
      if (fs.existsSync(extracted)) return extracted;
    } catch (e) { log('extract failed:', e.message.slice(0, 300)); }
  }
  return null;
}

// -------------------------------------------------------- protocol client -----
// One ZcodeClient == one zcode.cjs child process == ONE request slot.
// The CLI runs generateText sequentially, so concurrency comes from running
// several of these per account (see "worker pools" below) and giving every
// request its own idle child — never from queueing several requests into the
// same child (that is what made 4-6 sessions unusable, and a single timeout
// then SIGKILLed the child and failed every request queued behind it).
const rejectedModels = new Set();
const QUOTA_RE = /exceed quota|\b1005\b|balance.*empty|insufficient.*quota/i;
const CONC_RE = /concurren|rate.?limit|too many (?:requests|concurrent)|\b(?:1302|1303|1305|429)\b|overload/i;
// "Provider returned a business error" is the AI SDK's wrapper for a 2xx
// response carrying an error body — an upstream blip, not a client mistake.
// Quota is matched earlier (QUOTA_RE), so a retry here cannot hammer an
// already-drained account; MAX_RETRIES/TOTAL_BUDGET_MS bound the attempts.
const TRANSIENT_RE = /timeout|timed out|unusual activity|captcha|CLI exited|CLI not running|CLI write failed|warming up|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|\b(?:502|503|504|529)\b|temporar|unavailable|internal server error|business error/i;

// loadAccountRevision parses desktop log files synchronously; with several
// workers starting at once that would repeat the same work. Memoize briefly.
let revisionMemo = { at: 0, file: null, value: null };
function loadAccountRevisionCached(builtinFile) {
  if (revisionMemo.value && revisionMemo.file === builtinFile && Date.now() - revisionMemo.at < 60_000) {
    return revisionMemo.value;
  }
  const value = loadAccountRevision(builtinFile);
  revisionMemo = { at: Date.now(), file: builtinFile, value };
  return value;
}

class ZcodeClient {
  constructor(account, slot = 1) {
    this.account = account;
    this.slot = slot;
    this.child = null;
    this.ready = false;
    this.busy = false;            // owned by the dispatcher: one request at a time
    this.destroyed = false;
    this.recycleWhenIdle = false;
    this.id = 0;
    this.pending = new Map();
    this.restartDelay = 1000;
    this.restartTimer = null;
    this.syncGen = 0;
    this.lastUsed = Date.now();
    this.waitReason = 'starting';
    this.lastStderr = null;
    this.inFlightModel = null;
    // private cwd per worker so children never share workspace-level state
    this.ws = path.join(workspace(account), 'w' + slot);
    this.start();
  }

  get tag() { return `${this.account.name}#${this.slot}`; }

  start() {
    if (this.destroyed) return;
    this.restartTimer = null;
    const retryLater = why => {
      this.waitReason = why;
      log(why);
      this.restartTimer = setTimeout(() => this.start(), 10_000);
    };
    const cli = resolveCliRoot();
    if (!cli) {
      return retryLater('zcode.cjs not found — install/open the ZCode desktop app once (needs ~/.zcode credentials), or set GLM_BRIDGE_CLI; retrying every 10s');
    }
    const builtinFile = findBuiltinFile();
    if (!builtinFile) return retryLater('zcode-builtin.json not found next to the CLI; retrying every 10s');

    const acc = this.account;
    const accZcodeDir = path.join(acc.dir, '.zcode');
    const env = {
      ...process.env,
      ...proxyEnv(),
      // Per-account data root: the child resolves <dir>/.zcode/... itself.
      ZCODE_DATA_BASE_DIR: acc.dir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(accZcodeDir, 'v2', 'provider_config.json'),
    };
    try { fs.mkdirSync(this.ws, { recursive: true }); } catch { /* cwd below may exist */ }
    log(`spawning CLI [${this.tag}]:`, cli, '| builtin:', builtinFile);
    this.lastStderr = null;
    this.waitReason = 'spawning CLI';
    let child;
    try {
      child = spawn(process.execPath, [cli, 'app-server', '--stdio', '--surface', 'terminal'], {
        cwd: this.ws, env, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { return retryLater('spawn failed: ' + e.message); }
    this.child = child;
    this.builtinFile = builtinFile;
    this.ready = false;

    // An unhandled 'error' on stdin (EPIPE after the child died) would crash
    // the whole bridge and take every session down with it.
    child.stdin.on('error', () => { /* the exit handler cleans up */ });
    child.on('error', e => log(`cli [${this.tag}] process error:`, e.message));
    // setEncoding uses a StringDecoder: without it a multi-byte character
    // (any non-ASCII text) split across two chunks gets corrupted.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { log('cli stdout(non-json):', line.slice(0, 200)); continue; }
        if (this.child === child) this.onMessage(m);
      }
    });
    child.stderr.on('data', d => {
      for (const l of String(d).split('\n')) if (l.trim()) {
        this.lastStderr = l.slice(0, 300);
        log(`cli [${this.tag}]:`, this.lastStderr);
      }
    });
    child.on('exit', code => {
      // A stale child (already replaced/destroyed) must never touch live state
      // or schedule a second restart — that is how CLI processes used to leak.
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      for (const [, p] of this.pending) p.resolve({ error: { message: 'CLI exited' } });
      this.pending.clear();
      if (this.destroyed) return;
      this.waitReason = `CLI exited (code ${code}), restarting in ${this.restartDelay} ms${this.lastStderr ? ` — last stderr: ${this.lastStderr}` : ''}`;
      log(`[${this.tag}] ${this.waitReason}`);
      this.restartTimer = setTimeout(() => this.start(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
      pumpSoon();
    });

    this.syncAccountConfig();
  }

  onMessage(m) {
    // server -> client request: has `method` and `id`
    if (m.method && m.id !== undefined) {
      Promise.resolve(this.answerServerRequest(m)).catch(e =>
        log('answerServerRequest rejected:', e.message));
      return;
    }
    // client -> server response: has `id` and is in `this.pending`
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      p.resolve(m);
      return;
    }
    // notifications: state.updated, storageState, mcpTelemetry — ignored
  }

  async answerServerRequest(m) {
    let result = {};
    try {
      if (m.method === 'session/requestRuntimePreferences') {
        result = { nativeSearchEnhancementsEnabled: false };
      } else if (m.method === 'interaction/requestProviderRuntimeHeaders') {
        const reason = (m.params || {}).reason || 'model-request';
        // Fast path: GLM-5.3-Flash and standard models NEVER need captcha.
        // Only GLM-5.3 (premium) or explicit captcha-retry requests use tokens.
        // NEVER block an incoming request on Playwright (which takes 30-60s!)
        // If a token is in the pool, use it; if empty, refill in the background
        // and proceed immediately. (inFlightModel is per worker, and a worker
        // serves exactly one request at a time, so it cannot be clobbered.)
        const needsCaptcha = (this.inFlightModel === 'GLM-5.3') || reason === 'captcha-retry';
        let hdrs = {};
        if (needsCaptcha) {
          const tok = nextToken();
          if (tok) {
            hdrs = { 'x-device-token': tok };
          } else {
            ensureTokens(); // background non-blocking refill
          }
        }
        const jwt = loadJwt(this.account);
        result = { headersApplied: true, requestAuth: { apiKey: jwt, headers: hdrs } };
        log(`runtime headers applied (acc=${this.tag}, reason=${reason}, model=${this.inFlightModel || '?'}, captcha=${Object.keys(hdrs).length ? 'token' : 'none'}, pool=${tokens.length})`);
      } else {
        log('unhandled server request', m.method, JSON.stringify(m.params || {}).slice(0, 200));
        result = {};
      }
    } catch (e) {
      log('answerServerRequest error:', e.message);
      result = m.method === 'interaction/requestProviderRuntimeHeaders'
        ? { headersApplied: false, errorMessage: e.message } : {};
    }
    try {
      this.child.stdin.write(JSON.stringify({ id: m.id, result }) + '\n');
    } catch (e) { log('stdin write failed:', e.message); }
  }

  send(method, params, timeoutMs = 30_000, signal = null) {
    return new Promise(resolve => {
      const child = this.child;
      if (!child || !child.stdin.writable) {
        resolve({ error: { message: 'CLI not running' } });
        return;
      }
      if (signal && signal.aborted) {
        resolve({ error: { message: 'request aborted by client' }, aborted: true });
        return;
      }
      const id = 'req_' + (++this.id);
      const tStart = Date.now();
      let timer = null;
      let onAbort = null;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, {
        resolve: val => {
          cleanup();
          resolve(val);
        }
      });
      timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        log(`[send TIMEOUT ${this.tag}] ${id} ${method} elapsed=${Date.now() - tStart}ms timeoutMs=${timeoutMs}`);
        // This worker only ever carries this one request, so killing the hung
        // child no longer takes any other session's request down with it.
        if (this.child === child) this.ready = false;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve({ error: { message: `timeout waiting for ${method}` }, timedOut: true });
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            cleanup();
            resolve({ error: { message: 'request aborted by client' }, aborted: true });
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        cleanup();
        resolve({ error: { message: 'CLI write failed: ' + e.message } });
      }
    });
  }

  // Push the account config into a freshly started child. Retries until it
  // lands (a worker that never becomes ready would otherwise stall the pool),
  // and restarts the child if it never does.
  async syncAccountConfig() {
    const gen = ++this.syncGen;
    const child = this.child;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      if (this.destroyed || this.syncGen !== gen || this.child !== child || !child || child.exitCode !== null) return;
      let acct;
      try { acct = loadAccountRevisionCached(this.builtinFile); } catch (e) { log('revision error:', e.message); continue; }
      const r = await this.send('provider/updateAccountConfig', {
        revision: acct.revision,
        basedOnZCodeBuiltinRevision: acct.basedOnZCodeBuiltinRevision,
        providers: acct.providers,
        states: acct.states,
      }, 15_000);
      if (this.destroyed || this.syncGen !== gen) return;
      if (r.result && r.result.status) {
        this.ready = true;
        this.restartDelay = 1000;
        this.waitReason = null;
        log(`account config synced [${this.tag}] (${r.result.status}, providers=${r.result.providerCount})`);
        pumpSoon();
        return;
      }
      if (i % 5 === 4) log(`updateAccountConfig attempt failed [${this.tag}]:`, JSON.stringify(r.error || r).slice(0, 300));
    }
    if (!this.destroyed && this.syncGen === gen) {
      log(`WARN: [${this.tag}] account config not synced after ~90s, restarting CLI`);
      this.restartNow('config sync failed');
    }
  }

  restartNow(why = 'restart') {
    const child = this.child;
    this.ready = false;
    if (!child) return;
    log(`restarting CLI [${this.tag}] (${why})`);
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, 3000);
    if (t.unref) t.unref();
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    for (const [, p] of this.pending) p.resolve({ error: { message: 'CLI exited' } });
    this.pending.clear();
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }, 3000);
      if (t.unref) t.unref();
    }
  }

  // Runs exactly one upstream generation. The dispatcher guarantees this
  // worker is not used by anything else until the returned promise settles.
  async generate({ systemBlocks, messages, tools, maxOutputTokens, reasoningLevel, modelId, signal }) {
    const aborted = () => ({ error: { message: 'request aborted by client' }, aborted: true });
    if (!this.ready || !this.child) return { error: { message: 'bridge warming up, retry shortly' }, isTransient: true };
    if (signal && signal.aborted) return aborted();

    const accName = this.account.name;
    // Known-rejected models (registry lacks them) go straight to Flash —
    // otherwise every glm-5.3 request paid a ~10s upstream rejection first.
    const requestedModel = modelId || 'GLM-5.3-Flash';
    const effectiveModel = rejectedModels.has(requestedModel) ? 'GLM-5.3-Flash' : requestedModel;
    // Premium model billing: the upstream silently downgrades captcha-less
    // GLM-5.3 requests to GLM-5.3-Flash (verified by bucket deltas). Flag
    // the client so its runtime-headers responder attaches a token.
    this.inFlightModel = effectiveModel;
    const params = {
      operationId: 'op-' + crypto.randomUUID(),
      workspace: { workspacePath: this.ws, workspaceKey: this.ws },
      selection: {
        providerId: 'account:zai-start-plan',
        modelId: effectiveModel,
        options: { reasoningLevel: reasoningLevel || 'low' },
      },
      messages: [...systemBlocks, ...messages],
      querySource: 'bridge',
      maxOutputTokens,
    };
    if (tools && tools.length) params.tools = tools;

    let cancelAck = null;
    let onAbort = null;
    if (signal) {
      onAbort = () => {
        // Tell the CLI to stop (saves quota too) and remember to wait for the
        // ack in `finally`, so the next request is never handed a worker that
        // is still busy unwinding this one.
        try {
          const id = 'req_' + (++this.id);
          cancelAck = new Promise(res => this.pending.set(id, { resolve: res }));
          this.child.stdin.write(JSON.stringify({ id, method: 'workspace/cancelGenerateText', params: { operationId: params.operationId } }) + '\n');
        } catch { /* child gone; nothing to cancel */ }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const sendTimeoutMs = Number(process.env.GLM_BRIDGE_TIMEOUT_MS) || 300_000;
    const sendOnce = () => this.send('workspace/generateText', params, sendTimeoutMs, signal);

    try {
      let r = await sendOnce();
      if (signal && signal.aborted) return aborted();

      // If the upstream starts demanding captcha tokens again, recover on the
      // spot instead of failing the request: flip the policy and retry once.
      if (r.error && /3012|unusual activity|captcha/i.test(JSON.stringify(r.error))) {
        forceCaptchaRequired('upstream rejected the request');
        await sleep(400);
        r = await sendOnce();
        if (signal && signal.aborted) return aborted();
      }

      // The cached account revision may not list a newly added model (e.g.
      // GLM-5.3 joined the plan after the desktop last wrote its log). Only a
      // genuine registry/entitlement error marks the model rejected and falls
      // back to Flash. Quota and transient errors propagate so the dispatcher
      // can retry on another account/worker — never silently bill Flash.
      if (r.error && params.selection.modelId === 'GLM-5.3') {
        const errText = JSON.stringify(r.error);
        const isQuotaErr = QUOTA_RE.test(errText);
        const isTransient = /concurrency|rate limit|too many|timeout|timed out/i.test(errText);
        // NOTE: "model" appears in every AiSdk error string, so it must not
        // be part of the match.
        const isRegistryErr = !isQuotaErr && !isTransient
          && /entitle|not_found|notfound|not\s*(?:supported|available|registered)|unknown model|invalid model|not_entitled/i.test(errText);
        if (isQuotaErr) {
          log(`account "${accName}" GLM-5.3 quota exhausted`);
          return { error: r.error, isQuotaExhausted: true };
        }
        if (isRegistryErr) {
          if (!rejectedModels.has('GLM-5.3')) {
            log(`model GLM-5.3 registry-rejected (${errText.slice(0, 160)}), blacklisting globally`);
            rejectedModels.add('GLM-5.3');
          }
          params.selection.modelId = 'GLM-5.3-Flash';
          r = await sendOnce();
          if (signal && signal.aborted) return aborted();
        }
      }

      if (r.error) {
        const msg = JSON.stringify(r.error);
        log(`generateText error (req=${requestedModel} eff=${effectiveModel} acc=${this.tag}):`, msg.slice(0, 800));
        return { error: r.error, isQuotaExhausted: QUOTA_RE.test(msg), timedOut: !!r.timedOut };
      }

      let result = r.result;
      // Thinking can swallow a small output budget: retry once with a bigger cap.
      const empty = result && !result.text && !(result.toolCalls && result.toolCalls.length)
        && result.finishReason === 'length';
      if (empty && params.maxOutputTokens < 8192) {
        log('empty length-truncated response, retrying with maxOutputTokens=8192');
        params.maxOutputTokens = 8192;
        params.operationId = 'op-' + crypto.randomUUID();
        const r2 = await this.send('workspace/generateText', params, sendTimeoutMs, signal);
        if (signal && signal.aborted) return aborted();
        if (r2.result) result = r2.result;
        else if (r2.error) return { error: r2.error, timedOut: !!r2.timedOut };
      }
      quotaState.lastOkAt = Date.now();
      return { result };
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (cancelAck) {
        const acked = await Promise.race([cancelAck.then(() => true), sleep(4000).then(() => false)]);
        if (!acked) {
          log(`cancel not acknowledged within 4s [${this.tag}], recycling CLI`);
          this.restartNow('stuck after cancel');
        }
      }
    }
  }
}

// ------------------------------------------------------- message conversion --
// ZCode protocol message shapes:
//   {role:'system'|'user', content:string}
//   {role:'assistant', content:string, toolCalls?:[{id,name,input}]}
//   {role:'tool', content:string, toolCallId, toolName, isError?}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text'))
      .map(b => b.text || '')
      .join('');
  }
  return String(content);
}

const REQUIRED_SYSTEM = (() => {
  try {
    const blocks = JSON.parse(fs.readFileSync(SYSBLOCKS_PATH, 'utf8'));
    return blocks.map(b => ({ role: 'system', content: b.text }));
  } catch (e) {
    log('FATAL sysblocks.json missing/invalid:', e.message);
    process.exit(1);
  }
})();

function buildToolNameMap(openaiMessages) {
  const map = new Map();
  for (const m of openaiMessages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const t of m.tool_calls) if (t.id && t.function) map.set(t.id, t.function.name);
    }
  }
  return map;
}

function openaiToZcode(msgs) {
  const nameById = buildToolNameMap(msgs);
  const out = [];
  for (const m of msgs) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: textOf(m.content) });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: textOf(m.content) });
    } else if (m.role === 'assistant') {
      const entry = { role: 'assistant', content: textOf(m.content) };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        entry.toolCalls = m.tool_calls.map(t => ({
          id: t.id || crypto.randomUUID(),
          name: (t.function && t.function.name) || t.name || 'unknown',
          input: parseJsonSafe((t.function && t.function.arguments) || t.input || '{}'),
        }));
      }
      out.push(entry);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: textOf(m.content),
        toolCallId: m.tool_call_id || m.toolCallId || '',
        toolName: m.name || m.toolName || nameById.get(m.tool_call_id) || 'unknown',
        ...(m.is_error || m.isError ? { isError: true } : {}),
      });
    }
  }
  return out;
}

function anthropicToZcode(body) {
  const nameById = new Map();
  for (const m of body.messages || []) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') nameById.set(b.id, b.name);
    }
  }
  const out = [];
  for (const m of body.messages || []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: textOf(m.content) }];
    if (m.role === 'user') {
      // tool_result blocks become tool messages; plain text becomes user message
      const texts = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            content: textOf(b.content),
            toolCallId: b.tool_use_id,
            toolName: nameById.get(b.tool_use_id) || 'unknown',
            ...(b.is_error ? { isError: true } : {}),
          });
        } else if (b.type === 'text') {
          texts.push(b.text);
        }
        // thinking/signature blocks dropped
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
    } else if (m.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id || crypto.randomUUID(), name: b.name, input: b.input || {} });
        // redacted_thinking/thinking dropped
      }
      const entry = { role: 'assistant', content: texts.join('\n') };
      if (toolCalls.length) entry.toolCalls = toolCalls;
      out.push(entry);
    }
  }
  return out;
}

function parseJsonSafe(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

// ------------------------------------------------------------- HTTP layer ----
// ------------------------------------------------------------ worker pools ---
// How concurrency works now
//   * One zcode.cjs child serves ONE request at a time. Each account gets a
//     pool of up to GLM_BRIDGE_WORKERS children (default 4, grown on demand,
//     2 kept warm, idle extras reaped after 15 min).
//   * A request is handed an idle child; if none is free it waits in an
//     in-process queue (instant wake-up, abortable, no polling). Requests
//     without tools (title/summary side-calls) go ahead of the long agent
//     turns, with aging so nothing starves.
//   * Z.ai limits concurrent requests per user. When it pushes back, the
//     account's concurrency limit is halved and creeps back up after a streak
//     of successes, and the request is retried with backoff — the client
//     never sees the transient error.
//   Routing "fill-first" prefers the active account until it is saturated;
//   "round-robin" and "session-pin" both balance by load (pinning a session
//   to a child is pointless now that every request gets its own child).
const WORKERS_MAX = Math.max(1, Number(process.env.GLM_BRIDGE_WORKERS) || 4);
const WORKERS_WARM = Math.min(WORKERS_MAX, Math.max(1, Number(process.env.GLM_BRIDGE_WARM) || 2));
const WORKER_IDLE_MS = (Number(process.env.GLM_BRIDGE_IDLE_MIN) || 15) * 60_000;
const QUEUE_TIMEOUT_MS = Number(process.env.GLM_BRIDGE_QUEUE_TIMEOUT_MS) || 240_000;
const MAX_RETRIES = Number(process.env.GLM_BRIDGE_RETRIES) || 8;
const TOTAL_BUDGET_MS = Number(process.env.GLM_BRIDGE_BUDGET_MS) || 6 * 60_000;
const LIGHT_BONUS_MS = 10_000;

const accountPools = new Map();   // account name -> { name, workers[], limit, okStreak, lastShrinkAt }
const waiters = [];               // requests waiting for a free worker
let rrCounter = 0;

function getPool(name) {
  let p = accountPools.get(name);
  if (!p) {
    p = { name, workers: [], limit: WORKERS_MAX, okStreak: 0, lastShrinkAt: 0 };
    accountPools.set(name, p);
  }
  return p;
}
const poolBusy = p => p.workers.filter(w => w.busy && !w.destroyed).length;
function poolStats(name) {
  const p = accountPools.get(name);
  const ws = p ? p.workers.filter(w => !w.destroyed) : [];
  return {
    workers: ws.length,
    ready: ws.filter(w => w.ready).length,
    busy: ws.filter(w => w.busy).length,
    limit: p ? p.limit : WORKERS_MAX,
  };
}

function spawnWorker(pool, acc) {
  const used = new Set(pool.workers.map(w => w.slot));
  let slot = 1;
  while (used.has(slot)) slot++;
  const w = new ZcodeClient(acc, slot);
  pool.workers.push(w);
  return w;
}

// AIMD on the per-account concurrency limit.
function poolOnSuccess(name) {
  const p = getPool(name);
  p.okStreak++;
  if (p.limit < WORKERS_MAX && p.okStreak >= 15 && Date.now() - p.lastShrinkAt > 30_000) {
    p.limit++;
    p.okStreak = 0;
    log(`account "${name}" concurrency limit raised to ${p.limit}`);
    pumpSoon();
  }
}
function poolOnConcurrencyError(name) {
  const p = getPool(name);
  p.okStreak = 0;
  const now = Date.now();
  if (now - p.lastShrinkAt < 2000) return;       // one backoff per burst of errors
  p.lastShrinkAt = now;
  const next = Math.max(1, Math.floor(p.limit / 2));
  if (next !== p.limit) {
    log(`account "${name}" hit upstream concurrency limit, lowering concurrency ${p.limit} -> ${next}`);
    p.limit = next;
  }
}

function candidateAccounts(w8) {
  const now = Date.now();
  const all = loadAccounts().accounts
    .filter(a => !w8.tried.has(a.name) && fs.existsSync(accountCredFile(a)));
  const usable = all.filter(a => !(a.exhaustedUntil && a.exhaustedUntil > now)
    && !(a.quotaEmptyUntil && a.quotaEmptyUntil > now));
  const withModel = usable.filter(a => accountHasModelTokens(a.name, w8.model));
  if (withModel.length) return withModel;
  if (usable.length) return usable;
  return all;   // everything parked: still try, the parked state may be stale
}

function orderAccounts(accs, routing) {
  const active = loadAccounts().active;
  const rr = rrCounter++;
  const n = accs.length;
  return accs
    .map((a, i) => {
      const p = getPool(a.name);
      const busy = poolBusy(p);
      const saturated = busy >= p.limit;
      const preferred = routing === 'fill-first' && a.name === active && !saturated ? 0 : 1;
      return { a, preferred, load: busy / Math.max(1, p.limit), tie: (i + rr) % n };
    })
    .sort((x, y) => x.preferred - y.preferred || x.load - y.load || x.tie - y.tie)
    .map(x => x.a);
}

// Returns a ready idle worker, null (keep waiting, possibly after growing a
// pool), or 'none' when no account can serve this request at all.
function tryAssign(w8) {
  const accs = candidateAccounts(w8);
  if (!accs.length) return 'none';
  const ordered = orderAccounts(accs, getRoutingMode());
  for (const a of ordered) {
    const pool = getPool(a.name);
    if (poolBusy(pool) >= pool.limit) continue;
    const idle = pool.workers.find(w => w.ready && !w.busy && !w.destroyed);
    if (idle) return idle;
  }
  // Nothing idle: start one more child (one at a time per account, which also
  // staggers the CPU spike of booting several Node processes).
  for (const a of ordered) {
    const pool = getPool(a.name);
    const live = pool.workers.filter(w => !w.destroyed);
    if (live.length < pool.limit && !live.some(w => !w.ready)) {
      spawnWorker(pool, a);
      break;
    }
  }
  return null;
}

function pump() {
  if (!waiters.length) return;
  waiters.sort((a, b) =>
    (a.enq - (a.light ? LIGHT_BONUS_MS : 0)) - (b.enq - (b.light ? LIGHT_BONUS_MS : 0)));
  for (let i = 0; i < waiters.length;) {
    const w8 = waiters[i];
    const r = tryAssign(w8);
    if (r === 'none') { waiters.splice(i, 1); w8.finish({ reason: 'no-account' }); continue; }
    if (r) { waiters.splice(i, 1); r.busy = true; w8.finish({ worker: r }); continue; }
    i++;
  }
}
let pumpScheduled = false;
function pumpSoon() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  setImmediate(() => { pumpScheduled = false; pump(); });
}

function acquireWorker({ signal, model, tried, light }) {
  return new Promise(resolve => {
    if (signal && signal.aborted) return resolve({ reason: 'aborted' });
    const w8 = { enq: Date.now(), light: !!light, tried, model, timer: null, onAbort: null };
    const remove = () => { const i = waiters.indexOf(w8); if (i >= 0) waiters.splice(i, 1); };
    w8.finish = v => {
      clearTimeout(w8.timer);
      if (signal && w8.onAbort) signal.removeEventListener('abort', w8.onAbort);
      resolve(v);
    };
    w8.timer = setTimeout(() => { remove(); w8.finish({ reason: 'timeout' }); }, QUEUE_TIMEOUT_MS);
    if (signal) {
      w8.onAbort = () => { remove(); w8.finish({ reason: 'aborted' }); };
      signal.addEventListener('abort', w8.onAbort, { once: true });
    }
    waiters.push(w8);
    pump();
  });
}

function releaseWorker(w) {
  w.busy = false;
  w.lastUsed = Date.now();
  if (w.recycleWhenIdle) { w.recycleWhenIdle = false; w.restartNow('recycle'); }
  pumpSoon();
}

function warmPools() {
  for (const acc of getUsableAccounts()) {
    const pool = getPool(acc.name);
    const have = pool.workers.filter(w => !w.destroyed).length;
    for (let i = 0; i < WORKERS_WARM - have; i++) {
      setTimeout(() => {
        if (pool.workers.filter(w => !w.destroyed).length < WORKERS_WARM) spawnWorker(pool, acc);
      }, 500 * i);
    }
  }
}

function reapIdleWorkers() {
  const now = Date.now();
  for (const pool of accountPools.values()) {
    pool.workers = pool.workers.filter(w => !w.destroyed);
    for (const w of [...pool.workers]) {
      if (pool.workers.length <= WORKERS_WARM) break;
      if (!w.busy && w.ready && now - w.lastUsed > WORKER_IDLE_MS) {
        log(`reaping idle worker [${w.tag}]`);
        w.destroy();
        pool.workers = pool.workers.filter(x => x !== w);
      }
    }
  }
}

function shutdownPools() {
  for (const pool of accountPools.values()) for (const w of pool.workers) w.destroy();
}

// Restart children (e.g. after the proxy route changed) without killing
// anything in flight: idle ones now, busy ones as soon as they are released.
function recyclePools() {
  for (const pool of accountPools.values()) {
    for (const w of pool.workers) {
      if (w.destroyed) continue;
      if (w.busy) w.recycleWhenIdle = true; else w.restartNow('connectivity change');
    }
  }
}

const sleepAbortable = (ms, signal) => new Promise(resolve => {
  let t = null;
  const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); };
  t = setTimeout(done, ms);
  if (signal) signal.addEventListener('abort', done, { once: true });
});
const backoffMs = n => Math.round(Math.min(6000, 500 * Math.pow(1.8, n - 1)) * (0.75 + Math.random() * 0.5));

function classifyError(out) {
  if (out.aborted) return 'aborted';
  const err = out.error;
  const txt = typeof err === 'string' ? err : JSON.stringify(err || {});
  if (out.isQuotaExhausted || QUOTA_RE.test(txt)) return 'quota';
  if (CONC_RE.test(txt)) return 'concurrency';
  if (out.isTransient || out.timedOut || TRANSIENT_RE.test(txt)) return 'transient';
  return 'fatal';
}

const ABORTED = () => ({ error: { message: 'request aborted by client' }, aborted: true });

async function generateWithFailover(options) {
  const requestedModel = options.modelId || 'GLM-5.3-Flash';
  const light = !(options.tools && options.tools.length);
  const tried = new Set();          // accounts that are out of quota for THIS request
  const started = Date.now();
  let lastOut = null;
  let retries = 0;
  let timeoutRetries = 0;

  for (;;) {
    if (options.signal && options.signal.aborted) return ABORTED();

    const got = await acquireWorker({ signal: options.signal, model: requestedModel, tried, light });
    if (!got.worker) {
      if (got.reason === 'aborted') return ABORTED();
      if (got.reason === 'timeout') {
        return { error: { message: 'bridge is saturated: no free worker slot, retry shortly' }, isTransient: true };
      }
      // no account left to try
      if (lastOut && classifyError(lastOut) === 'quota') {
        markQuotaDrained();
        return {
          error: {
            message: 'All ZCode accounts exhausted (upstream code 1005). Wait for daily renewal (19:30) or add more accounts via `zbridge`.',
            type: 'insufficient_quota',
            code: 1005,
          },
          isQuotaExhausted: true,
        };
      }
      return lastOut || { error: { message: 'no usable ZCode account — run: glm-bridge login' } };
    }

    const w = got.worker;
    const accName = w.account.name;
    let out;
    try {
      out = await w.generate(options);
    } finally {
      releaseWorker(w);
    }

    if (!out.error) {
      clearAccountExhaustion(accName);
      poolOnSuccess(accName);
      return out;
    }
    if (out.aborted || (options.signal && options.signal.aborted)) return ABORTED();

    lastOut = out;
    const kind = classifyError(out);

    if (kind === 'quota') {
      if (requestedModel === 'GLM-5.3-Flash') {
        log(`account "${accName}" quota exhausted, marking paused`);
        markAccountExhausted(accName, '1005 quota exhausted');
      } else {
        // Only this model's bucket is drained; the account may still have Flash.
        log(`account "${accName}" has no ${requestedModel} tokens left, trying another account`);
        blockModel(accName, requestedModel, 10 * 60_000);
        refreshAccountPlan(loadAccounts().accounts.find(a => a.name === accName)).catch(() => {});
      }
      tried.add(accName);
      continue;    // next loop either finds another account or reports exhaustion
    }

    if (kind === 'concurrency' || kind === 'transient') {
      if (kind === 'concurrency') poolOnConcurrencyError(accName);
      if (out.timedOut && ++timeoutRetries > 1) return out;      // don't stack 5-minute waits
      if (++retries > MAX_RETRIES || Date.now() - started > TOTAL_BUDGET_MS) {
        log(`giving up after ${retries - 1} retries: ${JSON.stringify(out.error).slice(0, 200)}`);
        return out;
      }
      const delay = backoffMs(retries);
      log(`transient upstream error on "${accName}" (${kind}: ${JSON.stringify(out.error).slice(0, 120)}), retry ${retries}/${MAX_RETRIES} in ${delay}ms`);
      await sleepAbortable(delay, options.signal);
      continue;
    }

    return out;    // fatal (bad request etc.): retrying cannot help
  }
}

// Start plan (rev-30 builtin, CLI 3.14.4): GLM-5.3-Flash, GLM-5.2, GLM-5-Turbo.
// Plain GLM-5.3 belongs to the coding-plan providers; if the start plan
// rejects it, generate() falls back to Flash automatically.
const MODEL_ALIAS = new Map([
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm-flash', 'GLM-5.3-Flash'],
  ['glm-5.2', 'GLM-5.2'],
  ['glm-5-turbo', 'GLM-5-Turbo'],
  ['glm-turbo', 'GLM-5-Turbo'],
]);
function resolveModel(name) {
  if (!name) return 'GLM-5.3-Flash';
  const key = String(name).toLowerCase();
  if (MODEL_ALIAS.has(key)) return MODEL_ALIAS.get(key);
  // tolerate prefixed/suffixed ids harnesses send (e.g. "zcode/glm-5.3",
  // "glm-5.3-flash@preview")
  if (/turbo/.test(key)) return 'GLM-5-Turbo';
  if (/flash/.test(key)) return 'GLM-5.3-Flash';
  if (/5\.3/.test(key)) return 'GLM-5.3';
  if (/5\.2/.test(key)) return 'GLM-5.2';
  return 'GLM-5.3-Flash'; // default; echo requested id in responses
}

function clampMaxTokens(n, dflt = 8192) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return dflt;
  // ZCode thinking (reasoningLevel max) consumes output budget first; tiny caps
  // reliably return empty content, so floor the upstream cap.
  return Math.max(512, Math.min(128_000, Math.floor(v)));
}

function reasoningFromRequest(body) {
  // GLM spends most of its wall time on "thinking" at max effort: the visible
  // text only appears afterwards, so harnesses measure a low t/s. Default to
  // the level ZCode's own thinking budget maps to fastest-but-usable, and let
  // the caller (or GLM_BRIDGE_REASONING) opt into slower/deeper thinking.
  const env = (process.env.GLM_BRIDGE_REASONING || '').toLowerCase();
  const eff = (body.reasoning_effort || body.reasoningEffort || '').toLowerCase();
  const pick = v => (v === 'low' || v === 'high' || v === 'max' ? v : (env || 'low'));
  if (eff) return pick(eff === 'minimal' ? 'low' : eff);
  if (body.thinking && body.thinking.type === 'enabled') {
    // Anthropic thinking budget: small budgets mean the caller wants it cheap.
    const b = Number(body.thinking.budget_tokens || 0);
    return env || (b && b <= 4096 ? 'low' : 'high');
  }
  return env || 'low';
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function openaiToolDefs(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (t.type === 'function' && t.function) {
      out.push({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        inputSchema: t.function.parameters || { type: 'object', properties: {} },
      });
    } else if (t.name) {
      out.push({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} } });
    }
  }
  return out;
}

function toOpenAIToolCalls(toolCalls) {
  return toolCalls.map(t => ({
    id: t.id,
    type: 'function',
    function: { name: t.name, arguments: JSON.stringify(t.input && t.input._raw !== undefined ? t.input._raw : (t.input || {})) },
  }));
}

// Map an internal failure to what each client family understands, so Claude
// Code / OpenAI SDKs retry (529 / 503) instead of treating it as a hard error.
function upstreamErrorInfo(out) {
  const msg = `upstream: ${(out.error && out.error.message) || JSON.stringify(out.error)}`;
  const kind = classifyError(out);
  if (kind === 'quota') return { msg, aStatus: 429, oStatus: 429, aType: 'rate_limit_error', oType: 'insufficient_quota' };
  if (kind === 'transient' || kind === 'concurrency') {
    return { msg, aStatus: 529, oStatus: 503, aType: 'overloaded_error', oType: 'server_error', retryAfter: 5 };
  }
  return { msg, aStatus: 502, oStatus: 502, aType: 'api_error', oType: 'upstream_error' };
}

// The text is already fully generated, so there is nothing to gain from one
// SSE event per word; ~200-char deltas cut CPU on both sides.
function chunkText(text, size = 200) {
  const words = text.match(/\S+|\s+/g) || [text];
  const out = [];
  let cur = '';
  for (const w of words) {
    cur += w;
    if (cur.length >= size) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

// Generation can take minutes (plus queue time). Without periodic bytes,
// clients and proxies treat the idle stream as dead and report an API error.
function startKeepalive(res, payload, ms = 8000) {
  const t = setInterval(() => {
    try { if (!res.writableEnded && !res.destroyed) res.write(payload); } catch { /* client gone */ }
  }, ms);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'connection': 'keep-alive',
  'x-accel-buffering': 'no',
};

async function handleChatCompletions(req, res, body) {
  log(`[chat/completions] model=${body.model} stream=${body.stream} msgs=${(body.messages || []).length}`);
  const requestedModel = body.model || 'GLM-5.3-Flash';
  const model = resolveModel(requestedModel);
  const systemBlocks = [
    ...REQUIRED_SYSTEM,
    ...(Array.isArray(body.messages) ? body.messages.filter(m => m.role === 'system') : []),
  ].map(m => ({ role: 'system', content: textOf(m.content) }));
  const messages = openaiToZcode((body.messages || []).filter(m => m.role !== 'system'));
  if (!messages.length) return sendJson(res, 400, { error: { message: 'messages required', type: 'invalid_request_error' } });

  const created = Math.floor(Date.now() / 1000);
  const id = 'chatcmpl-' + crypto.randomUUID();
  const genOpts = () => ({
    systemBlocks,
    messages,
    tools: openaiToolDefs(body.tools),
    maxOutputTokens: clampMaxTokens(body.max_tokens ?? body.max_completion_tokens),
    reasoningLevel: reasoningFromRequest(body),
    modelId: model,
    signal: req.signal,
  });

  if (body.stream) {
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    const chunk = delta => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [delta] })}\n\n`;
    res.write(chunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null }));

    const stopKeepalive = startKeepalive(res, ': keepalive\n\n');
    let out;
    try { out = await generateWithFailover(genOpts()); } finally { stopKeepalive(); }

    if (req.signal && req.signal.aborted) {
      log('client aborted; closing stream');
      res.destroy();
      return;
    }
    if (out.error) {
      const info = upstreamErrorInfo(out);
      res.write(`data: ${JSON.stringify({ error: { message: info.msg, type: info.oType } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const r = out.result || {};
    const toolCalls = (r.toolCalls && r.toolCalls.length) ? toOpenAIToolCalls(r.toolCalls) : null;
    const usage = r.usage || {};
    const finish = toolCalls ? 'tool_calls' : (r.finishReason === 'stop' || !r.finishReason ? 'stop' : r.finishReason);

    let payload = '';
    if (r.text) for (const part of chunkText(r.text)) payload += chunk({ index: 0, delta: { content: part } });
    if (toolCalls) payload += chunk({ index: 0, delta: { tool_calls: toolCalls.map((t, i) => ({ index: i, ...t })) } });
    payload += chunk({ index: 0, delta: {}, finish_reason: finish });
    if (body.stream_options && body.stream_options.include_usage) {
      payload += `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [], usage: {
        prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens || 0,
      } })}\n\n`;
    }
    payload += 'data: [DONE]\n\n';
    res.write(payload);
    res.end();
    return;
  }

  const out = await generateWithFailover(genOpts());
  if (req.signal && req.signal.aborted) {
    log('client aborted; terminating connection');
    res.destroy();
    return;
  }
  if (out.error) {
    const info = upstreamErrorInfo(out);
    return sendJson(res, info.oStatus, { error: { message: info.msg, type: info.oType } },
      info.retryAfter ? { 'retry-after': String(info.retryAfter) } : {});
  }
  const r = out.result || {};
  const toolCalls = (r.toolCalls && r.toolCalls.length) ? toOpenAIToolCalls(r.toolCalls) : null;
  const usage = r.usage || {};
  const message = { role: 'assistant', content: r.text || '' };
  if (toolCalls) message.tool_calls = toolCalls;
  const finish = toolCalls ? 'tool_calls' : (r.finishReason === 'stop' || !r.finishReason ? 'stop' : r.finishReason);
  sendJson(res, 200, {
    id, object: 'chat.completion', created, model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: usage.inputTokens || 0,
      completion_tokens: usage.outputTokens || 0,
      total_tokens: usage.totalTokens || 0,
    },
  });
}

async function handleAnthropicMessages(req, res, body, stream) {
  const requestedModel = body.model || 'GLM-5.3-Flash';
  let sysBlocks = [];
  if (typeof body.system === 'string') sysBlocks = [{ role: 'system', content: body.system }];
  else if (Array.isArray(body.system)) {
    sysBlocks = body.system.filter(b => b && typeof b.text === 'string').map(b => ({ role: 'system', content: b.text }));
  }
  const systemBlocks = [...REQUIRED_SYSTEM, ...sysBlocks];
  const messages = anthropicToZcode(body);
  if (!messages.length) return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages required' } });

  const id = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const genOpts = () => ({
    systemBlocks,
    messages,
    tools: openaiToolDefs((body.tools || []).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))),
    maxOutputTokens: clampMaxTokens(body.max_tokens),
    reasoningLevel: reasoningFromRequest(body),
    modelId: resolveModel(requestedModel),
    signal: req.signal,
  });

  if (stream) {
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(ev('message_start', { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', model: requestedModel, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } }));

    const stopKeepalive = startKeepalive(res, ev('ping', { type: 'ping' }));
    let out;
    try { out = await generateWithFailover(genOpts()); } finally { stopKeepalive(); }

    if (req.signal && req.signal.aborted) {
      log('client aborted; closing stream');
      res.destroy();
      return;
    }
    if (out.error) {
      const info = upstreamErrorInfo(out);
      res.write(ev('error', { type: 'error', error: { type: info.aType, message: info.msg } }));
      res.end();
      return;
    }
    const r = out.result || {};
    const stopReason = (r.toolCalls && r.toolCalls.length) ? 'tool_use' : 'end_turn';
    const usage = r.usage || {};
    let payload = '';
    let idx = 0;
    if (r.text) {
      payload += ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      for (const part of chunkText(r.text)) {
        payload += ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: part } });
      }
      payload += ev('content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
    }
    for (const t of (r.toolCalls || [])) {
      payload += ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } });
      payload += ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } });
      payload += ev('content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
    }
    if (idx === 0) {
      payload += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      payload += ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    }
    payload += ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.outputTokens || 0 } });
    payload += ev('message_stop', { type: 'message_stop' });
    res.write(payload);
    res.end();
    return;
  }

  const out = await generateWithFailover(genOpts());
  if (req.signal && req.signal.aborted) {
    log('client aborted; terminating connection');
    res.destroy();
    return;
  }
  if (out.error) {
    const info = upstreamErrorInfo(out);
    return sendJson(res, info.aStatus, { type: 'error', error: { type: info.aType, message: info.msg } },
      info.retryAfter ? { 'retry-after': String(info.retryAfter) } : {});
  }
  const r = out.result || {};
  const content = [];
  if (r.text) content.push({ type: 'text', text: r.text });
  for (const t of (r.toolCalls || [])) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
  const stopReason = (r.toolCalls && r.toolCalls.length) ? 'tool_use' : 'end_turn';
  const usage = r.usage || {};
  return sendJson(res, 200, {
    id, type: 'message', role: 'assistant', model: requestedModel,
    content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0 },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-key'] || '');
  return key === config.key;
}

const server = http.createServer(async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) {
      ac.abort();
    }
  });
  req.signal = ac.signal;
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname !== '/health') log(`[http] ${req.method} ${url.pathname} from port ${req.socket.remotePort} UA=${req.headers['user-agent'] || 'none'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const accountsData = loadAccounts();
      const anyCreds = accountsData.accounts.some(a => fs.existsSync(accountCredFile(a)));
      const allWorkers = [...accountPools.values()].flatMap(p => p.workers.filter(w => !w.destroyed));
      const cliRunning = allWorkers.some(c => c.child && c.child.exitCode === null);
      const anyReady = allWorkers.some(c => c.ready);
      const activeWorkers = (accountPools.get(activeAccount().name) || { workers: [] }).workers;
      const activeC = activeWorkers.find(c => c.ready) || activeWorkers[0] || null;

      const accountsList = accountsData.accounts.map(a => {
        const hasCreds = fs.existsSync(accountCredFile(a));
        const p = accountPlans.get(a.name);
        const ps = poolStats(a.name);
        const isExhausted = !!((a.exhaustedUntil && a.exhaustedUntil > Date.now()) ||
                               (a.quotaEmptyUntil && a.quotaEmptyUntil > Date.now()));
        return {
          name: a.name,
          active: a.name === accountsData.active,
          hasCredentials: hasCreds,
          ready: ps.ready > 0,
          workers: ps.workers,
          busy: ps.busy,
          concurrencyLimit: ps.limit,
          exhausted: isExhausted,
          exhaustedUntil: a.exhaustedUntil || null,
          quotaEmptyUntil: a.quotaEmptyUntil || null,
          quotaLeft: p ? p.quotaLeft : null,
          remainingTokens: p ? p.remainingTokens : null,
          totalTokens: p ? p.totalTokens : null,
        };
      });

      const drained = quotaState.lastQuotaAt > quotaState.lastOkAt;
      let action = null;
      if (drained) {
        if (planCache.active === false) {
          action = 'CLAIM NEEDED: open the ZCode desktop app and click Claim on the 100M tokens card'
            + ' (or run: glm-bridge claim) — the bridge\'s headless claim is blocked by captcha (3007)';
        } else if (planCache.active && planCache.endsAt) {
          const mins = Math.max(0, Math.round((planCache.endsAt * 1000 - Date.now()) / 60000));
          action = `plan active but quota drained — renews in ~${mins} min`
            + ` (at ${new Date(planCache.endsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })});`
            + ' if a claim card is offered in the ZCode GUI, claiming it speeds this up';
        } else {
          action = 'quota drained — checking plan state; if no plan shows in the ZCode GUI, claim the 100M card there';
        }
      }
      if (Date.now() - planCache.at > 30_000) refreshPlan().catch(() => {});
      return sendJson(res, 200, {
        ok: true,
        ready: anyReady || !!(activeC && activeC.ready),
        routing: getRoutingMode(),
        account: activeAccount().name,
        accounts: accountsData.accounts.length,
        accountsList,
        captchaPool: tokens.length,
        queue: waiters.length,
        inflight: allWorkers.filter(w => w.busy).length,
        workersPerAccount: WORKERS_MAX,
        cliRunning,
        credentials: anyCreds,
        quota: drained ? 'drained' : 'ok',
        quotaLeft: planCache.quotaLeft || null,
        quotaSummary: planCache.quotaSummary || null,
        quotaPercent: planCache.percent ?? null,
        quotaTokens: planCache.remainingTokens ?? null,
        quotaTotal: planCache.totalTokens ?? null,
        quotaDetails: planCache.balances || [],
        modelQuotas: planCache.modelQuotas || accountPlans.get(activeAccount().name)?.modelQuotas || {},
        plan: planCache.active === null ? 'unknown' : (planCache.active ? 'active' : 'missing'),
        action,
        detail: !cliRunning ? (activeC?.waitReason || 'CLI not running')
          : !anyCreds ? 'CLI running but ZCode credentials missing'
          : (anyReady || activeC?.ready) ? null : (activeC?.waitReason || 'CLI up, syncing account config'),
      });
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      warmPools();
      refreshPlan().catch(() => {});
      return sendJson(res, 200, { ok: true, accounts: loadAccounts().accounts.length });
    }
    if (!checkAuth(req)) return sendJson(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      // Distinct ids only (no case-duplicates — those showed up as
      // "2 glm5.3 flash" on 9router import). glm-5.3 is served via the
      // rejected-model fallback until an account has it entitled.
      return sendJson(res, 200, { object: 'list', data: [
        { id: 'glm-5.3', object: 'model', owned_by: 'zcode-start-plan', created: created_ts },
        { id: 'glm-5.3-flash', object: 'model', owned_by: 'zcode-start-plan', created: created_ts },
      ] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }
      return await handleChatCompletions(req, res, body);
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }); }
      return await handleAnthropicMessages(req, res, body, body.stream === true);
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw || '{}'); } catch { /* fallthrough */ }
      const est = Math.max(1, Math.ceil(JSON.stringify(body || {}).length / 4));
      return sendJson(res, 200, { input_tokens: est });
    }
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    log('http error:', e.stack || e.message);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message, type: 'server_error' } });
    else try { res.end(); } catch { /* ignore */ }
  }
});

const created_ts = Math.floor(Date.now() / 1000);

// Node's default keep-alive timeout is 5s: a client reusing a pooled
// connection right as the server closes it gets ECONNRESET, which shows up as
// random "API error"s in Claude Code. Keep idle connections far longer than
// any client does, and never time out a long generation.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;
server.timeout = 0;
server.on('connection', s => { s.setNoDelay(true); s.setKeepAlive(true, 30_000); });
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

// ------------------------------------------------------------- CLI wrapper ---
// `glm-bridge start|stop|restart|status|logs|run` — cross-platform.
// Default (no args / `run`): run in foreground (systemd/schtasks uses this).
const argv = process.argv.slice(2);
const sub = (argv[0] || 'run').toLowerCase();

function isAlive(pid) {
  try {
    if (IS_WIN) {
      const txt = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { stdio: 'pipe', timeout: 10_000 }).toString();
      return txt.split(/\r?\n/)[0].startsWith('"');
    }
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function readPid() {
  try { return Number(fs.readFileSync(PID_PATH, 'utf8').trim()) || null; } catch { return null; }
}

function writePid(pid) { fs.writeFileSync(PID_PATH, String(pid)); }
// Find whoever currently holds our TCP port (a stale instance from an earlier
// run would otherwise survive `stop` and block the next `start`).
function portHolders() {
  const out = [];
  const mine = new Set([readPid(), process.pid].filter(Boolean));
  const add = pid => { if (pid && !mine.has(pid)) out.push(pid); };
  try {
    if (IS_WIN) {
      const txt = execFileSync('netstat', ['-ano'], { stdio: 'pipe', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).toString();
      for (const line of txt.split(/\r?\n/)) {
        if (new RegExp(`[:.]${config.port}\\s`).test(line) && /LISTENING/i.test(line)) {
          add(Number(line.trim().split(/\s+/).pop()));
        }
      }
    } else {
      for (const bin of ['ss', 'lsof', 'fuser']) {
        try {
          if (bin === 'ss') {
            const txt = execFileSync('ss', ['-ltnpH'], { stdio: 'pipe', timeout: 10_000 }).toString();
            for (const line of txt.split(/\n/)) {
              if (line.includes(`:${config.port} `)) {
                for (const m of line.matchAll(/pid=(\d+)/g)) add(Number(m[1]));
              }
            }
          } else if (bin === 'lsof') {
            const txt = execFileSync('lsof', ['-ti', `tcp:${config.port}`, '-sTCP:LISTEN'], { stdio: 'pipe', timeout: 10_000 }).toString();
            for (const l of txt.split(/\n/)) if (l.trim()) add(Number(l.trim()));
          } else {
            const txt = execFileSync('fuser', [`${config.port}/tcp`], { stdio: 'pipe', timeout: 10_000 }).toString();
            for (const l of txt.split(/\s+/)) if (l) add(Number(l));
          }
          if (out.length) break;
        } catch { /* try next tool */ }
      }
    }
  } catch { /* best effort */ }
  return [...new Set(out)];
}

function spawnDetached() {
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [__filename, 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, GLM_BRIDGE_QUIET: '1' },
  });
  child.unref();
  return child.pid;
}

const SERVICE_NAME = 'glm-bridge';

// ------------------------------------------------------------- plan claim ----
// The ZCode "Start Plan" offer (100M tokens) refreshes daily and must be
// claimed, otherwise the bridge hits "exceed quota limit" (1005). Claiming
// needs the desktop's Aliyun captcha flow, so we delegate to claim-plan.js,
// which replays that flow in a headless browser and then POSTs the claim.
const CLAIM_SCRIPT = path.join(ASSET_DIR, 'claim-plan.js');
const CLAIM_AT = process.env.GLM_BRIDGE_CLAIM_AT || '19:30';
const CLAIM_PLAN = process.env.GLM_BRIDGE_PLAN || 'zcode-v3-start-plan';
const CLAIM_DISABLED = process.env.GLM_BRIDGE_CLAIM_DISABLE === '1';
let claiming = false;
let lastClaimAttempt = 0;

function runClaim(force) {
  if (claiming) return Promise.resolve({ ok: false, reason: 'claim already in flight' });
  if (!force && Date.now() - lastClaimAttempt < 10 * 60_000) {
    return Promise.resolve({ ok: false, reason: 'throttled' });
  }
  if (!fs.existsSync(CLAIM_SCRIPT)) {
    return Promise.resolve({ ok: false, reason: 'claim-plan.js missing' });
  }
  claiming = true;
  lastClaimAttempt = Date.now();
  const targets = loadAccounts().accounts.filter(a => fs.existsSync(accountCredFile(a)));
  if (!targets.length) {
    claiming = false;
    return Promise.resolve({ ok: false, reason: 'no logged-in accounts' });
  }
  const claimOne = (acc) => new Promise(resolve => {
    const argv = [CLAIM_SCRIPT, '--plan', CLAIM_PLAN, '--json'];
    if (force) argv.push('--force');
    log(`claim: starting for account "${acc.name}"` + (force ? ' (scheduled daily run)' : ''));
    execFile(process.execPath, argv,
      { env: { ...process.env, ...proxyEnv(), ZCODE_CREDENTIALS: accountCredFile(acc) },
        timeout: 12 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
        let res = null;
        try { res = JSON.parse(line); } catch { /* fall through */ }
        if (!res) res = { ok: false, detail: String(stdout).slice(0, 300) || (err && err.message) || 'no output' };
        log(`claim[${acc.name}]: ` + JSON.stringify(res).slice(0, 600));
        resolve({ account: acc.name, ...res });
      });
  });
  return (async () => {
    const results = [];
    for (const acc of targets) results.push(await claimOne(acc));
    claiming = false;
    const okAll = results.every(r => r.ok || r.claimed);
    return { ok: okAll, results };
  })();
}

function scheduleClaims() {
  if (CLAIM_DISABLED) { log('claim: auto-claim disabled (GLM_BRIDGE_CLAIM_DISABLE=1)'); return; }
  const parts = String(CLAIM_AT).split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number.isFinite(hh) ? hh : 19, Number.isFinite(mm) ? mm : 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const wait = next - now;
  log(`claim: daily attempt at ${CLAIM_AT} (in ${Math.round(wait / 60000)} min); ` +
      `self-heal check every 30 min while the plan is inactive`);
  setTimeout(() => {
    runClaim(true).finally(() => setTimeout(scheduleClaims, 5000));
  }, wait);
  setInterval(() => { runClaim(false).catch(() => {}); }, 30 * 60_000);
}
// ------------------------------------------------------- autostart / tray ---
function autostartOn() {
  if (IS_WIN) {
    // /XML output is not localized and distinguishes disabled tasks from
    // existing ones (plain /Query returns 0 even for a disabled task).
    try {
      const xml = execFileSync('schtasks', ['/Query', '/TN', SERVICE_NAME, '/XML'],
        { stdio: 'pipe', timeout: 15_000 }).toString();
      return /<Enabled>true<\/Enabled>/.test(xml);
    } catch { return false; }
  }
  // systemd user unit if installed, else the XDG autostart entry
  try { execFileSync('systemctl', ['--user', 'is-enabled', SERVICE_NAME + '.service'], { stdio: 'pipe', timeout: 15_000 }); return true; }
  catch (e) { if (String(e.stdout || '').trim() === 'enabled') return true; }
  return fs.existsSync(path.join(HOME, '.config', 'autostart', SERVICE_NAME + '.desktop'));
}
function setAutostart(on) {
  if (IS_WIN) {
    try {
      if (on) execFileSync('schtasks', ['/Change', '/TN', SERVICE_NAME, '/ENABLE'], { stdio: 'pipe' });
      else execFileSync('schtasks', ['/Change', '/TN', SERVICE_NAME, '/DISABLE'], { stdio: 'pipe' });
    } catch (e) { console.error('autostart change failed:', e.message); }
    return;
  }
  const unit = path.join(HOME, '.config', 'systemd', 'user', SERVICE_NAME + '.service');
  const desktop = path.join(HOME, '.config', 'autostart', SERVICE_NAME + '.desktop');
  if (fs.existsSync(unit)) {
    try { execFileSync('systemctl', ['--user', on ? 'enable' : 'disable', SERVICE_NAME + '.service'], { stdio: 'pipe' }); }
    catch (e) { console.error('systemctl failed:', e.message); }
    return;
  }
  if (on) {
    fs.mkdirSync(path.dirname(desktop), { recursive: true });
    fs.writeFileSync(desktop, `[Desktop Entry]\nType=Application\nName=GLM bridge\nExec="${process.execPath}" "${ASSET_DIR}/glm-bridge.js" run\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
  } else { fs.rmSync(desktop, { force: true }); }
}
function killTray() {
  try {
    const t = Number(fs.readFileSync(TRAY_PID_PATH, 'utf8').trim());
    if (t) {
      // tray.sh is spawned detached (its own process group): kill the group so
      // the yad child dies too, otherwise systemd's cgroup stop times out.
      try { process.kill(-t, 'SIGTERM'); } catch { process.kill(t, 'SIGTERM'); }
    }
  } catch { /* no tray */ }
  fs.rmSync(TRAY_PID_PATH, { force: true });
}
function startTray() {
  if (IS_WIN) {
    const ps1 = path.join(ASSET_DIR, 'tray.ps1');
    if (!fs.existsSync(ps1)) { console.error('tray.ps1 missing'); process.exitCode = 1; return; }
    spawn('powershell', ['-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { stdio: 'ignore', detached: true }).unref();
    console.log('tray started (Windows NotifyIcon)');
    return;
  }
  const py = path.join(ASSET_DIR, 'tray.py');
  if (fs.existsSync(py)) {
    spawn('python3', [py], { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
    console.log('tray started (AppIndicator)');
    return;
  }
  const sh = path.join(ASSET_DIR, 'tray.sh');
  if (!fs.existsSync(sh)) { console.error('tray helper missing'); process.exitCode = 1; return; }
  spawn('sh', [sh], { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
  console.log('tray started (legacy)');
}

// ------------------------------------------------------ account commands ----
async function cliLogin(ref) {
  const cli = resolveCliRoot();
  if (!cli) { console.error('zcode.cjs not found — install ZCode first (or set GLM_BRIDGE_CLI)'); process.exitCode = 1; return; }
  const builtin = findBuiltinFile();
  const accs = loadAccounts();
  const name = String(ref ?? '').trim();
  let acc = name ? resolveAccountRef(accs, name) : null;
  if (name && !acc && /^\d+$/.test(name)) {
    console.error(`account #${name} does not exist (see: glm-bridge accounts)`);
    process.exitCode = 1; return;
  }
  if (name && !acc) {
    // new account: its own data base dir under STATE_DIR/accounts/<name>
    const dir = path.join(STATE_DIR, 'accounts', name);
    fs.mkdirSync(dir, { recursive: true });
    acc = { name, dir, addedAt: Date.now() };
    accs.accounts.push(acc);
    saveAccounts(accs);
    console.log(`created account "${name}" -> ${dir}`);
  }
  if (!acc) acc = activeAccount();
  // Refuse before the OAuth dance: signing in with an account that is already
  // linked elsewhere just creates a second name for one quota/plan.
  const dupBefore = duplicateOf(acc, accs.accounts);
  if (dupBefore) {
    console.error(`✖ "${acc.name}" is already signed in as the same Z.AI account as "${dupBefore.name}".`);
    console.error(`  Signing in again would share one plan/quota — no extra capacity.`);
    console.error(`  Use a different Z.AI account (incognito/private window), or drop the old entry first:`);
    console.error(`    glm-bridge logout ${dupBefore.name}`);
    process.exitCode = 1;
    return;
  }
  const env = {
    ...process.env, ...proxyEnv(),
    ZCODE_DATA_BASE_DIR: acc.dir,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(acc.dir, '.zcode', 'v2', 'provider_config.json'),
  };
  if (builtin) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
  console.log(`\n================================================================================`);
  console.log(`  Logging in Z.AI Account "${acc.name}"`);
  console.log(`================================================================================\n`);
  console.log(`Starting login helper...`);

  // Retry loop: the OAuth init POST to chat.z.ai intermittently fails when
  // egress flaps ("Error: fetch failed") — the child exits before printing
  // any URL. Retry up to 3 times before giving up.
  const loginStartedAt = Date.now();
  let loginCode = 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.log(`\nretrying login (attempt ${attempt}/3) in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
    loginCode = await new Promise(resolve => {
      // On Windows the CLI auto-opens the browser via `cmd /c start "" <url>`;
      // the URL is passed unquoted, so cmd splits it at the first '&' and the
      // browser opens a param-less authorize URL ("Field required" error).
      // Use --no-browser there and open the URL ourselves, quoted.
      const args = [cli, 'login'];
      if (process.platform === 'win32') args.push('--no-browser');
      const p = spawn(process.execPath, args, { env, stdio: ['inherit', 'pipe', 'pipe'] });
      let urlFound = false;

      const onData = (chunk) => {
        const text = chunk.toString();
        const urlMatch = text.match(/https:\/\/chat\.z\.ai\/api\/oauth\/authorize\S+/);
        if (urlMatch && !urlFound) {
          urlFound = true;
          const authUrl = urlMatch[0];
          // Windows-safe auto-open: quote the URL for cmd's `start`.
          try {
            if (process.platform === 'win32') {
              spawn('cmd.exe', ['/c', 'start', '', authUrl], { detached: true, stdio: 'ignore' }).unref();
            } else if (process.platform === 'darwin') {
              spawn('open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
            } else {
              spawn('xdg-open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
            }
            console.log(`Opening your browser...\n`);
          } catch { /* fall back to manual copy/paste */ }
          console.log(`\n┌────────────────────────────────────────────────────────────────────────┐`);
          console.log(`│  AUTHORIZATION LINK:                                                   │`);
          console.log(`│                                                                        │`);
          console.log(`│  ${authUrl}`);
          console.log(`│                                                                        │`);
          console.log(`│  ★ TO LINK A SECOND / DIFFERENT ACCOUNT:                               │`);
          console.log(`│    Open this link in a PRIVATE / INCOGNITO browser window so you can   │`);
          console.log(`│    sign in with a DIFFERENT phone number / account!                    │`);
          console.log(`└────────────────────────────────────────────────────────────────────────┘\n`);
          console.log(`Waiting for sign-in completion in browser (or Ctrl+C to cancel)...\n`);
        } else if (!urlFound) {
          process.stdout.write(text);
        }
      };

      p.stdout.on('data', onData);
      p.stderr.on('data', d => {
        const s = d.toString();
        if (!s.includes('ZCode Built-in Provider Config')) process.stderr.write(s);
      });
      p.on('exit', code => resolve(code === 0 ? 0 : 1));
    });
    // Success criteria: fresh credentials written during THIS login attempt.
    const credFile = accountCredFile(acc);
    const fresh = fs.existsSync(credFile) && fs.statSync(credFile).mtimeMs >= loginStartedAt;
    if (fresh) { loginCode = 0; break; }
    if (loginCode === 0 && !fresh) {
      console.log('\n⚠ process exited but no fresh credentials were written (stale credentials file present).');
      loginCode = 1;
    }
    // If the URL was shown, do NOT retry — the user may be mid-sign-in; wait
    // is handled above by the child blocking until completion or Ctrl+C.
  }

  if (loginCode === 0 && fs.existsSync(accountCredFile(acc))) {
    credCache.clear();
    // Post-login guard: if the sign-in landed on an account that is already
    // linked under another name, undo it — the new credentials would just
    // duplicate a plan. Wiping them also restores the previous (different)
    // login for this entry.
    const dupAfter = duplicateOf(acc, accs.accounts);
    if (dupAfter) {
      fs.rmSync(accountCredFile(acc), { force: true });
      credCache.clear();
      console.error(`\n✖ That Z.AI account is already linked as "${dupAfter.name}".`);
      console.error(`  Reverted: credentials for "${acc.name}" were discarded so the two entries do not share one plan.`);
      process.exitCode = 1;
      return;
    }
    clearAccountExhaustion(acc.name);
    console.log(`\n✔ Login successful for "${acc.name}"!`);
    // Auto-claim: a fresh account only carries the baseline 3M+5M daily plan;
    // the 100M trust offer is claimable right after signup — mint a captcha
    // token and claim it headlessly (same route as the GUI button).
    console.log(`  checking for claimable plan offers...`);
    try {
      const { execFile } = require('child_process');
      // claim-plan.js requires X-Device-Mid (preview returns 3001 without it).
      // A pure CLI login may not have written telemetry-state.json yet — the
      // GUI writes it on first API use. Create it with a random UUID if so.
      const v2Dir = path.join(acc.dir, '.zcode', 'v2');
      const telemetryFile = path.join(v2Dir, 'telemetry-state.json');
      if (!fs.existsSync(telemetryFile)) {
        try { fs.mkdirSync(v2Dir, { recursive: true }); } catch {}
        const mid = crypto.randomUUID();
        fs.writeFileSync(telemetryFile, JSON.stringify({ deviceMid: mid }, null, 2));
        log(`generated deviceMid ${mid} for "${acc.name}"`);
      }
      const claimScript = path.join(__dirname, 'claim-plan.js');
      if (fs.existsSync(claimScript)) {
        await new Promise(resolve => {
          execFile(process.execPath, [claimScript], {
            env: { ...process.env, ...proxyEnv(), ZCODE_CREDENTIALS: accountCredFile(acc) },
            timeout: 180_000,
          }, (err, stdout) => {
            const s = String(stdout || '').trim();
            if (s) console.log(`  claim: ${s}`);
            resolve();
          });
        });
      }
    } catch {}
    await refreshAccountPlan(acc).catch(() => {});
    const plan = accountPlans.get(acc.name);
    if (plan && plan.quotaLeft) {
      console.log(`  Initial Quota: ${plan.quotaLeft}`);
    }
    if (accs.active !== acc.name && name) {
      console.log(`  Switch active account: glm-bridge use "${acc.name}"`);
    }
    try {
      await fetch(`http://127.0.0.1:${config.port}/reload`, { method: 'POST', signal: AbortSignal.timeout(1500) });
    } catch {}
  } else if (loginCode !== 0) {
    console.log('\n✖ Login failed after 3 attempts (network error or cancelled).');
    process.exitCode = 1;
  } else {
    console.log('\n✖ Credentials not written — login may have timed out or been cancelled.');
    process.exitCode = 1;
  }
}
function cliLogout(ref) {
  const accs = loadAccounts();
  const acc = ref ? resolveAccountRef(accs, ref) : activeAccount();
  if (!acc) { console.error(`account "${ref}" not found`); process.exitCode = 1; return; }
  fs.rmSync(accountCredFile(acc), { force: true });
  if (acc.name === 'main') {
    // also ask the CLI to clear shared state it may hold for $HOME
    try {
      const cli = resolveCliRoot();
      if (cli) execFileSync(process.execPath, [cli, 'logout'], { stdio: 'pipe', timeout: 30_000, env: { ...process.env, ZCODE_DATA_BASE_DIR: acc.dir } });
    } catch { /* best effort */ }
  }
  console.log(`logged out "${acc.name}"`);
}
function listAccounts() {
  const a = loadAccounts();
  const routing = getRoutingMode();
  console.log(`Routing mode: ${routing}\n`);
  a.accounts.forEach((x, i) => {
    const loggedIn = fs.existsSync(accountCredFile(x));
    const exhausted = (x.exhaustedUntil && x.exhaustedUntil > Date.now()) || (x.quotaEmptyUntil && x.quotaEmptyUntil > Date.now());
    const reason = x.exhaustedUntil ? `exhausted-until ${new Date(x.exhaustedUntil).toLocaleTimeString()}` : (x.quotaEmptyUntil ? 'quota-empty' : '');
    const p = accountPlans.get(x.name);
    const qStr = p && p.quotaLeft ? `\t${p.quotaLeft}` : '';
    const dup = loggedIn ? duplicateOf(x, a.accounts) : null;
    const dupStr = dup ? `\tDUPLICATE of "${dup.name}"` : '';
    console.log(`${x.name === a.active ? '*' : ' '} ${i + 1}. ${x.name}\t${loggedIn ? 'logged-in' : 'no-credentials'}` +
      `${exhausted ? '\t' + reason : '\tactive'}${qStr}${dupStr}\t${x.dir}`);
  });
}
function useAccount(ref) {
  if (!ref) { console.error('usage: glm-bridge use <number|name>'); process.exitCode = 1; return; }
  const a = loadAccounts();
  const acc = resolveAccountRef(a, ref);
  if (!acc) { console.error(`account "${ref}" not found (see: glm-bridge accounts)`); process.exitCode = 1; return; }
  const dup = duplicateOf(acc, a.accounts);
  if (dup) console.warn(`warn: "${acc.name}" is the same Z.AI login as "${dup.name}" — shared quota, no extra capacity`);
  if (!fs.existsSync(accountCredFile(acc))) console.warn(`warn: "${acc.name}" has no credentials — run: glm-bridge login ${acc.name}`);
  a.active = acc.name; saveAccounts(a);
  credCache.clear();
  console.log(`active account: ${acc.name}`);
}

async function ctl() {
  // If something is already serving our port but the pid file is stale or
  // missing, adopt that process so status/stop act on the real owner.
  const adoptPortHolder = () => {
    const holders = portHolders();
    if (holders.length === 1) {
      try { writePid(holders[0]); } catch { /* ignore */ }
      return holders[0];
    }
    return null;
  };
  let pid = readPid();
  let alive = !!(pid && isAlive(pid));
  // If a service manager owns the bridge, delegate to it: otherwise systemd /
  // the Scheduled Task would immediately resurrect a process we just killed.
  const service = (() => {
    if (IS_WIN) {
      try {
        execFileSync('schtasks', ['/Query', '/TN', SERVICE_NAME], { stdio: 'pipe', timeout: 15_000 });
        return { kind: 'schtasks', name: SERVICE_NAME };
      } catch { return null; }
    }
    try {
      execFileSync('systemctl', ['--user', 'cat', SERVICE_NAME + '.service'], { stdio: 'pipe', timeout: 15_000 });
      return { kind: 'systemd', name: SERVICE_NAME };
    } catch { return null; }
  })();
  const svc = (action) => {
    try {
      if (service.kind === 'systemd') {
        execFileSync('systemctl', ['--user', action, service.name], { stdio: 'pipe', timeout: 30_000 });
      } else if (action === 'start') {
        execFileSync('schtasks', ['/Run', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 });
      } else if (action === 'restart') {
        // schtasks has no restart: End is best-effort (task may not be running),
        // then Run it again — End alone left Windows restarts timing out.
        try { execFileSync('schtasks', ['/End', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 }); } catch { /* not running */ }
        execFileSync('schtasks', ['/Run', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 });
      } else {
        execFileSync('schtasks', ['/End', '/TN', service.name], { stdio: 'pipe', timeout: 30_000 });
      }
      return true;
    } catch { return false; }
  };
  const svcState = () => {
    try {
      if (service.kind === 'systemd') {
        return execFileSync('systemctl', ['--user', 'is-active', service.name], { stdio: 'pipe', timeout: 15_000 }).toString().trim();
      }
      execFileSync('schtasks', ['/Query', '/TN', service.name], { stdio: 'pipe', timeout: 15_000 });
      return 'running';
    } catch { return 'inactive'; }
  };
  const health = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  };
  if (sub === 'start' || sub === 'restart') {
    if (sub === 'start' && (await health())) {
      console.log(alive ? `already running (pid ${pid})` : 'already running');
      return;
    }
    if (service) {
      svc(sub === 'restart' ? 'restart' : 'start');
    } else if (sub === 'restart') {
      stop();
      await new Promise(r => setTimeout(r, 1200));
    }
    if (service) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await health()) { console.log(`started -> http://127.0.0.1:${config.port}/v1`); return; }
        await new Promise(r => setTimeout(r, 400));
      }
      console.error('start timed out; last log lines:');
      try { console.log(fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-6).join('\n')); } catch {}
      process.exitCode = 1;
      return;
    }
    const newPid = spawnDetached();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await health()) {
        console.log(`started (pid ${newPid}) -> http://127.0.0.1:${config.port}/v1`);
        return;
      }
      if (newPid && !isAlive(newPid)) break; // died: report instead of waiting out the timeout
      await new Promise(r => setTimeout(r, 400));
    }
    console.error('start failed; last log lines:');
    try { console.log(fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-6).join('\n')); } catch {}
    process.exitCode = 1;
  } else if (sub === 'stop') {
    if (service) {
      console.log(`stopping via ${service.kind}...`);
      svc('stop');
      await new Promise(r => setTimeout(r, 800));
      if (await health()) { console.log('service stop did not take; killing directly...'); stop(); }
      else console.log('stopped');
    } else { stop(); }
  } else if (sub === 'status') {
    const up = await health();
    if (up && !alive) { const adopted = adoptPortHolder(); if (adopted) { pid = adopted; alive = true; } }
    const via = service ? `${service.kind}:${svcState()}` : 'process';
    console.log(up ? `running (pid ${pid || 'unknown'}, ${via})` : `stopped (${via})`);
    if (up) {
      try {
        const h = await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) })).json();
        console.log(JSON.stringify(h));
        if (h.modelQuotas && Object.keys(h.modelQuotas).length) {
          console.log('\nModel Quotas:');
          for (const [mName, mData] of Object.entries(h.modelQuotas)) {
            console.log(`  • ${mName.padEnd(16)}: ${mData.label || mData.remainingFormatted}`);
          }
        }
      } catch { console.log('health: unreachable'); }
    } else if (!alive) {
      process.exitCode = 1;
    }
  } else if (sub === 'claim') {
    const force = argv.includes('--force');
    const r = await runClaim(force);
    let captchaBlocked = false;
    const report = (acct, x) => {
      const line = x.claimed ? 'claimed' : (x.ok ? (x.reason || 'ok') : 'FAILED ' + (x.detail || ''));
      console.log(`${acct}: ${line}`);
      if (!x.claimed && /3007|captcha/i.test(String(x.detail || ''))) captchaBlocked = true;
    };
    if (r.results) {
      for (const x of r.results) report(x.account, x);
      if (!r.ok) process.exitCode = 1;
    } else if (r.claimed) console.log('claimed: ' + (r.planId || CLAIM_PLAN));
    else {
      report('claim', r);
      if (!r.ok) process.exitCode = 1;
    }
    if (captchaBlocked) {
      console.error('\nheadless captcha was rejected (3007). GUI fallback:');
      console.error('  open the ZCode desktop app → click "Claim" on the 100M tokens card.');
      console.error('  The bridge picks the plan up automatically within a minute.');
    }
  } else if (sub === 'autostart') {
    console.log(autostartOn() ? 'on' : 'off');
  } else if (sub === 'autostart-toggle') {
    const now = autostartOn();
    setAutostart(!now);
    console.log(autostartOn() ? 'on' : 'off');
  } else if (sub === 'quit') {
    // Full stop: tray, service/process — the "Quit" tray item.
    killTray();
    if (service) { svc('stop'); stop(); } else { stop(); }
  } else if (sub === 'tray') {
    startTray();
  } else if (sub === 'login') {
    await cliLogin(argv[1]);
  } else if (sub === 'logout') {
    cliLogout(argv[1]);
  } else if (sub === 'accounts') {
    listAccounts();
  } else if (sub === 'use') {
    useAccount(argv[1]);
  } else if (sub === 'routing') {
    const mode = argv[1];
    if (mode) {
      try {
        setRoutingMode(mode);
        console.log(`routing mode set to: ${mode}`);
      } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
      }
    } else {
      console.log(`current routing mode: ${getRoutingMode()}`);
    }
  } else if (sub === 'logs') {
    const n = Number(argv[1] || 40);
    try {
      const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
      console.log(lines.slice(-n).join('\n'));
    } catch { console.log('no logs yet'); }
  } else if (sub === 'run') {
    // handled in main()
  } else if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log('usage: glm-bridge [start|stop|restart|status|logs [n]|run|claim [--force]|quit|tray|autostart|autostart-toggle|login [number|name]|logout [number|name]|accounts|use <number|name>]');
  } else {
    console.error(`unknown command: ${sub}`);
    process.exitCode = 1;
  }

  function stop() {
    const targets = [];
    if (alive) targets.push(pid);
    targets.push(...portHolders());
    if (!targets.length) {
      console.log('not running');
      try { fs.rmSync(PID_PATH, { force: true }); } catch {}
      return;
    }
    for (const t of targets) {
      try {
        if (IS_WIN) execFileSync('taskkill', ['/PID', String(t), '/T', '/F'], { stdio: 'pipe', timeout: 10_000 });
        else { try { process.kill(-t, 'SIGTERM'); } catch { process.kill(t, 'SIGTERM'); } }
        console.log(`stopped (pid ${t})`);
      } catch (e) { console.error(`stop failed (pid ${t}):`, e.message); }
    }
    try { fs.rmSync(PID_PATH, { force: true }); } catch {}
  }
}

async function main() {
  if (sub === 'run') {
    boot();
    return;
  }
  if (['status','start','restart','stop','logs','claim','help','--help','-h',
       'quit','tray','autostart','autostart-toggle','login','logout','accounts','use','routing'].includes(sub)) {
    await ctl();
    return;
  }
  if (sub === 'tui') {
    const tui = path.join(ASSET_DIR, 'zbridge.js');
    if (!fs.existsSync(tui)) { console.error('zbridge.js missing'); process.exitCode = 1; return; }
    spawn(process.execPath, [tui], { stdio: 'inherit', env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } })
      .on('exit', c => { process.exitCode = c || 0; });
    return;
  }
  console.error(`unknown command: ${sub}`);
  process.exitCode = 1;
}

function boot() {
  rotateLogIfBig();
  // A stray exception in one request path must not take every session down.
  process.on('uncaughtException', e => log('uncaughtException:', e && e.stack || e));
  process.on('unhandledRejection', e => log('unhandledRejection:', e && e.stack || e));
  writePid(process.pid);
  loadTokens();
  saveTokens();

  server.listen(config.port, '127.0.0.1', () => {
    log(`glm-bridge listening on http://127.0.0.1:${config.port}/v1 (key: ${config.key})`);
  });

  // Spawn the CLI immediately; when the connectivity probe settles on a
  // non-direct route, the periodic checker respawns the child (SIGHUP ->
  // exit handler) so it inherits the proxy env. This keeps /health truthful
  // within seconds on machines where every probe times out (VPN off etc.).
  warmPools();
  resolveProxy(true)
    .then(() => { if (resolvedProxy) recyclePools(); })   // children started before the route was known
    .then(() => refreshPlan())          // warm plan cache for /health actions
    .then(() => captchaPolicyRequired())
    .then(() => { if (tokens.length < 4) ensureTokens(); })   // pre-warm for GLM-5.3
    .catch(e => log('bootstrap error:', e.message));

  scheduleClaims();

  // System tray (best-effort): Auto-start toggle + Quit. Skip when disabled
  // or when there is no display / helper script.
  if (process.env.GLM_BRIDGE_TRAY !== '0') {
    try {
      const trayPid = Number(fs.existsSync(TRAY_PID_PATH) ? fs.readFileSync(TRAY_PID_PATH, 'utf8') : 0);
      const trayAlive = trayPid && isAlive(trayPid);
      if (!trayAlive) {
        if (IS_WIN) {
          const ps1 = path.join(ASSET_DIR, 'tray.ps1');
          if (fs.existsSync(ps1)) {
            spawn('powershell', ['-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1],
              { stdio: 'ignore', detached: true }).unref();
            log('tray helper started (Windows NotifyIcon)');
          }
        } else {
          const py = path.join(ASSET_DIR, 'tray.py');
          const sh = path.join(ASSET_DIR, 'tray.sh');
          if (fs.existsSync(py)) {
            spawn('python3', [py],
              { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
            log('tray helper started (AppIndicator)');
          } else if (fs.existsSync(sh)) {
            spawn('sh', [sh],
              { stdio: 'ignore', detached: true, env: { ...process.env, GLM_BRIDGE_HOME: STATE_DIR } }).unref();
            log('tray helper started (sh/yad)');
          }
        }
      }
    } catch (e) { log('tray start skipped:', e.message); }
  }

  setInterval(async () => {
    const before = resolvedProxy;
    await resolveProxy(true);
    if (resolvedProxy !== before) {
      log(`connectivity changed (${before || 'direct'} -> ${resolvedProxy || 'direct'}), recycling workers when idle`);
      recyclePools();
    }
    reapIdleWorkers();
    warmPools();
    // Always keep a small captcha pool: GLM-5.3 (premium) requests MUST carry
    // a token or the upstream silently downgrades them to Flash (billing the
    // Flash bucket). Minting ~60s/token means the pool must be pre-warmed,
    // not built on demand.
    captchaPolicyRequired().then(() => { if (tokens.length < 4) ensureTokens(); }).catch(() => {});
  }, 5 * 60_000);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('shutting down');
      // Kill the tray helper too: it lives in this cgroup, and systemd would
      // otherwise wait for it, time out and mark the unit failed on every stop.
      try { killTray(); } catch { /* ignore */ }
      try { shutdownPools(); } catch { /* ignore */ }
      try { fs.rmSync(PID_PATH, { force: true }); } catch {}
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
