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
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

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
// ZCode keeps its CLI data in ~/.zcode on Linux, macOS and Windows alike
const ZCODE_DIR = path.join(HOME, '.zcode');
const CRED_PATH = path.join(ZCODE_DIR, 'v2', 'credentials.json');
const WORKSPACE = path.join(ZCODE_DIR, 'workspace', 'default');
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

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
  if (process.env.GLM_BRIDGE_QUIET !== '1') process.stdout.write(line);
}

const config = (() => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  if (!c.key) {
    c.key = 'glm-local-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
    log('generated bridge key ->', c.key);
  }
  c.port = Number(process.env.GLM_BRIDGE_PORT || c.port || 3010);
  if (process.env.GLM_BRIDGE_KEY) c.key = process.env.GLM_BRIDGE_KEY;
  return c;
})();

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

let credCache = { at: 0, jwt: null };
function loadJwt() {
  if (Date.now() - credCache.at < 60_000 && credCache.jwt) return credCache.jwt;
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const jwt = decryptCredential(raw['zcodejwttoken']);
  credCache = { at: Date.now(), jwt };
  return jwt;
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
  return t;
}
function ensureTokens(background = true) {
  if (minting || tokens.length >= 8) return;
  if (!fs.existsSync(MINT_SCRIPT)) { log('mint script missing:', MINT_SCRIPT); return; }
  minting = true;
  const out = path.join(STATE_DIR, `tokens-mint-${Date.now()}.json`);
  const p = spawn(process.execPath, [MINT_SCRIPT, '10', out], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => log('[mint]', String(d).trim()));
  p.stderr.on('data', d => log('[mint:err]', String(d).trim().slice(0, 300)));
  p.on('exit', code => {
    minting = false;
    try {
      const fresh = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (Array.isArray(fresh) && fresh.length) {
        loadTokens();
        tokens = [...new Set([...tokens, ...fresh])];
        saveTokens();
        log(`minted ${fresh.length} captcha tokens (pool=${tokens.length})`);
      }
      fs.rmSync(out, { force: true });
    } catch (e) { log('mint merge failed:', e.message); }
    if (tokens.length < 4) setTimeout(() => ensureTokens(), 2000);
  });
  if (!background) { /* caller may poll pool */ }
}

function captchaHeader() {
  let tok = nextToken();
  if (!tok) {
    // synchronous last resort: block until one batch lands (mint takes ~20s)
    ensureTokens();
    const deadline = Date.now() + 90_000;
    while (!tok && Date.now() < deadline) {
      // sync wait that works on Windows too (no /bin/sleep there)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      loadTokens();
      tok = nextToken();
    }
  }
  if (!tok) return null;
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
  const roots = [path.join(ZCODE_DIR, 'v2', 'runtime', 'provider')];
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

function loadAccountRevision(builtinFile) {
  const computed = builtinRevisionFor(builtinFile);
  // 1) newest desktop log line (desktop host is the source of truth)
  try {
    const logDir = path.join(ZCODE_DIR, 'v2', 'logs');
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
class ZcodeClient {
  constructor() {
    this.child = null;
    this.ready = false;
    this.id = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.restartDelay = 1000;
    this.start();
  }

  start() {
    const cli = resolveCliRoot();
    if (!cli) {
      log('zcode.cjs not found (open the ZCode app, or set GLM_BRIDGE_CLI); retrying in 10s');
      setTimeout(() => this.start(), 10_000);
      return;
    }
    const builtinFile = findBuiltinFile();
    if (!builtinFile) { log('zcode-builtin.json not found; retrying in 10s'); setTimeout(() => this.start(), 10_000); return; }
    const env = {
      ...process.env,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(ZCODE_DIR, 'v2', 'provider_config.json'),
    };
    log('spawning CLI:', cli, '| builtin:', builtinFile);
    this.child = spawn(process.execPath, [cli, 'app-server', '--stdio', '--surface', 'terminal'], {
      cwd: WORKSPACE, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.builtinFile = builtinFile;
    this.ready = false;

    let buf = '';
    this.child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { log('cli stdout(non-json):', line.slice(0, 200)); continue; }
        this.onMessage(m);
      }
    });
    this.child.stderr.on('data', d => {
      for (const l of String(d).split('\n')) if (l.trim()) log('cli:', l.slice(0, 300));
    });
    this.child.on('exit', code => {
      log('CLI exited with', code, '- restarting in', this.restartDelay, 'ms');
      this.ready = false;
      for (const [, p] of this.pending) p.resolve({ error: { message: 'CLI exited' } });
      this.pending.clear();
      setTimeout(() => this.start(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    });

    this.syncAccountConfig();
  }

  onMessage(m) {
    // server -> client request
    if (m.method && m.id !== undefined && !this.pending.has(m.id)) {
      this.answerServerRequest(m);
      return;
    }
    // client -> server response
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      p.resolve(m);
      return;
    }
    // notifications: state.updated etc. — ignored (generateText is request/response)
  }

  answerServerRequest(m) {
    let result = {};
    try {
      if (m.method === 'session/requestRuntimePreferences') {
        result = { nativeSearchEnhancementsEnabled: false };
      } else if (m.method === 'interaction/requestProviderRuntimeHeaders') {
        const hdrs = captchaHeader();
        if (!hdrs) {
          result = { headersApplied: false, errorMessage: 'captcha token pool exhausted' };
          log('captcha pool empty; refusing header request');
        } else {
          const jwt = loadJwt();
          result = { headersApplied: true, requestAuth: { apiKey: jwt, headers: hdrs } };
          log(`runtime headers applied (reason=${(m.params || {}).reason}, pool=${tokens.length})`);
        }
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

  send(method, params, timeoutMs = 30_000) {
    return new Promise(resolve => {
      if (!this.child || !this.child.stdin.writable) {
        resolve({ error: { message: 'CLI not running' } });
        return;
      }
      const id = ++this.id;
      this.pending.set(id, { resolve });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: { message: `timeout waiting for ${method}` } });
        }
      }, timeoutMs);
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async syncAccountConfig() {
    // wait for the runtime to come up, then push account config (retry a few times)
    for (let i = 0; i < 20 && !this.ready; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!this.child || this.child.exitCode !== null) return;
      // probe: storage handshake happens first; try sync every 2s
      if (i % 4 !== 3) continue;
      let acct;
      try { acct = loadAccountRevision(this.builtinFile); } catch (e) { log('revision error:', e.message); continue; }
      const r = await this.send('provider/updateAccountConfig', {
        revision: acct.revision,
        basedOnZCodeBuiltinRevision: acct.basedOnZCodeBuiltinRevision,
        providers: acct.providers,
        states: acct.states,
      }, 10_000);
      if (r.result && r.result.status) {
        this.ready = true;
        this.restartDelay = 1000;
        log(`account config synced (${r.result.status}, providers=${r.result.providerCount})`);
        return;
      }
      log('updateAccountConfig attempt failed:', JSON.stringify(r.error || r).slice(0, 300));
    }
    log('WARN: account config not synced after retries');
  }

  // Serialize upstream calls: Aliyun captcha can reject duplicate concurrent submits.
  generate({ systemBlocks, messages, tools, maxOutputTokens, reasoningLevel }) {
    const run = async () => {
      if (!this.ready) {
        // one nudge in case sync is lagging
        await this.syncAccountConfig();
        if (!this.ready) return { error: { message: 'bridge warming up, retry shortly' } };
      }
      const params = {
        workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE },
        selection: {
          providerId: 'account:zai-start-plan',
          modelId: 'GLM-5.3-Flash',
          options: { reasoningLevel: reasoningLevel || 'max' },
        },
        messages: [...systemBlocks, ...messages],
        querySource: 'bridge',
        maxOutputTokens,
      };
      if (tools && tools.length) params.tools = tools;
      const r = await this.send('workspace/generateText', params, 300_000);
      if (r.error) {
        const msg = JSON.stringify(r.error);
        log('generateText error:', msg.slice(0, 500));
        return { error: r.error };
      }
      let result = r.result;
      // Thinking can swallow a small output budget: retry once with a bigger cap.
      const empty = result && !result.text && !(result.toolCalls && result.toolCalls.length)
        && result.finishReason === 'length';
      if (empty && params.maxOutputTokens < 8192) {
        log('empty length-truncated response, retrying with maxOutputTokens=8192');
        params.maxOutputTokens = 8192;
        const r2 = await this.send('workspace/generateText', params, 300_000);
        if (r2.result) result = r2.result;
        else if (r2.error) return { error: r2.error };
      }
      return { result };
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(() => {}, () => {});
    return p;
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
// Lazy: control commands (status/stop/logs) must not boot the whole runtime.
let client = null;
function getClient() {
  if (!client) client = new ZcodeClient();
  return client;
}

const MODEL_ALIAS = new Map([
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm-5.3', 'GLM-5.3-Flash'],
  ['glm-5.2', 'GLM-5.3-Flash'],
  ['glm-4.7', 'GLM-5.3-Flash'],
]);
function resolveModel(name) {
  if (!name) return 'GLM-5.3-Flash';
  const key = String(name).toLowerCase();
  if (key === 'glm-5.3-flash') return 'GLM-5.3-Flash';
  if (MODEL_ALIAS.has(key)) return MODEL_ALIAS.get(key);
  return 'GLM-5.3-Flash'; // single entitled model; echo requested id in responses
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

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
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

async function handleChatCompletions(req, res, body) {
  const requestedModel = body.model || 'GLM-5.3-Flash';
  const model = resolveModel(requestedModel);
  const systemBlocks = [
    ...REQUIRED_SYSTEM,
    ...(Array.isArray(body.messages) ? body.messages.filter(m => m.role === 'system') : []),
  ].map(m => ({ role: 'system', content: textOf(m.content) }));
  const messages = openaiToZcode((body.messages || []).filter(m => m.role !== 'system'));
  if (!messages.length) return sendJson(res, 400, { error: { message: 'messages required', type: 'invalid_request_error' } });

  const out = await getClient().generate({
    systemBlocks,
    messages,
    tools: openaiToolDefs(body.tools),
    maxOutputTokens: clampMaxTokens(body.max_tokens ?? body.max_completion_tokens),
    reasoningLevel: reasoningFromRequest(body),
  });
  if (out.error) {
    return sendJson(res, 502, { error: { message: `upstream: ${out.error.message || JSON.stringify(out.error)}`, type: 'upstream_error' } });
  }
  const r = out.result || {};
  const toolCalls = (r.toolCalls && r.toolCalls.length) ? toOpenAIToolCalls(r.toolCalls) : null;
  const usage = r.usage || {};
  const message = { role: 'assistant', content: r.text || '' };
  if (toolCalls) message.tool_calls = toolCalls;
  const finish = toolCalls ? 'tool_calls' : (r.finishReason === 'stop' || !r.finishReason ? 'stop' : r.finishReason);
  const created = Math.floor(Date.now() / 1000);
  const id = 'chatcmpl-' + crypto.randomUUID();

  if (body.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache', connection: 'keep-alive',
    });
    const chunk = delta => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [delta] })}\n\n`;
    res.write(chunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null }));
    if (r.text) res.write(chunk({ index: 0, delta: { content: r.text } }));
    if (toolCalls) res.write(chunk({ index: 0, delta: { tool_calls: toolCalls.map((t, i) => ({ index: i, ...t })) } }));
    res.write(chunk({ index: 0, delta: {}, finish_reason: finish }));
    if (body.stream_options && body.stream_options.include_usage) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [], usage: {
        prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens || 0,
      } })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

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

  const out = await getClient().generate({
    systemBlocks,
    messages,
    tools: openaiToolDefs((body.tools || []).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))),
    maxOutputTokens: clampMaxTokens(body.max_tokens),
    reasoningLevel: reasoningFromRequest(body),
  });
  if (out.error) {
    return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `upstream: ${out.error.message || JSON.stringify(out.error)}` } });
  }
  const r = out.result || {};
  const content = [];
  if (r.text) content.push({ type: 'text', text: r.text });
  for (const t of (r.toolCalls || [])) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
  const stopReason = (r.toolCalls && r.toolCalls.length) ? 'tool_use' : 'end_turn';
  const usage = r.usage || {};
  const id = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    return sendJson(res, 200, {
      id, type: 'message', role: 'assistant', model: requestedModel,
      content, stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0 },
    });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache', connection: 'keep-alive',
  });
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(ev('message_start', { type: 'message_start', message: {
    id, type: 'message', role: 'assistant', model: requestedModel, content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: usage.inputTokens || 0, output_tokens: 0 },
  } }));
  let idx = 0;
  if (r.text) {
    res.write(ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
    res.write(ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: r.text } }));
    res.write(ev('content_block_stop', { type: 'content_block_stop', index: idx }));
    idx++;
  }
  for (const t of (r.toolCalls || [])) {
    res.write(ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } }));
    res.write(ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } }));
    res.write(ev('content_block_stop', { type: 'content_block_stop', index: idx }));
    idx++;
  }
  if (idx === 0) { // empty response still needs one block
    res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
  }
  res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.outputTokens || 0 } }));
  res.write(ev('message_stop', { type: 'message_stop' }));
  res.end();
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
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, ready: !!(client && client.ready), captchaPool: tokens.length, cliRunning: !!(client && client.child && client.child.exitCode === null) });
    }
    if (!checkAuth(req)) return sendJson(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [
        { id: 'GLM-5.3-Flash', object: 'model', owned_by: 'zcode-start-plan', created: created_ts },
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

// ------------------------------------------------------------- CLI wrapper ---
// `glm-bridge start|stop|restart|status|logs|run` — cross-platform.
// Default (no args / `run`): run in foreground (systemd/schtasks uses this).
const argv = process.argv.slice(2);
const sub = (argv[0] || 'run').toLowerCase();

function isAlive(pid) {
  try {
    if (IS_WIN) {
      execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe' }).toString();
      // tasklist prints the row if alive
      return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe' })
        .toString().split(/\r?\n/)[0].startsWith('"');
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
      const txt = execFileSync('netstat', ['-ano'], { stdio: 'pipe' }).toString();
      for (const line of txt.split(/\r?\n/)) {
        if (new RegExp(`[:.]${config.port}\\s`).test(line) && /LISTENING/i.test(line)) {
          add(Number(line.trim().split(/\s+/).pop()));
        }
      }
    } else {
      for (const bin of ['ss', 'lsof', 'fuser']) {
        try {
          if (bin === 'ss') {
            const txt = execFileSync('ss', ['-ltnpH'], { stdio: 'pipe' }).toString();
            for (const line of txt.split(/\n/)) {
              if (line.includes(`:${config.port} `)) {
                for (const m of line.matchAll(/pid=(\d+)/g)) add(Number(m[1]));
              }
            }
          } else if (bin === 'lsof') {
            const txt = execFileSync('lsof', ['-ti', `tcp:${config.port}`, '-sTCP:LISTEN'], { stdio: 'pipe' }).toString();
            for (const l of txt.split(/\n/)) if (l.trim()) add(Number(l.trim()));
          } else {
            const txt = execFileSync('fuser', [`${config.port}/tcp`], { stdio: 'pipe' }).toString();
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
        execFileSync('schtasks', ['/Query', '/TN', SERVICE_NAME], { stdio: 'pipe' });
        return { kind: 'schtasks', name: SERVICE_NAME };
      } catch { return null; }
    }
    try {
      execFileSync('systemctl', ['--user', 'cat', SERVICE_NAME + '.service'], { stdio: 'pipe' });
      return { kind: 'systemd', name: SERVICE_NAME };
    } catch { return null; }
  })();
  const svc = (action) => {
    try {
      if (service.kind === 'systemd') {
        execFileSync('systemctl', ['--user', action, service.name], { stdio: 'pipe' });
      } else if (action === 'start') {
        execFileSync('schtasks', ['/Run', '/TN', service.name], { stdio: 'pipe' });
      } else {
        execFileSync('schtasks', ['/End', '/TN', service.name], { stdio: 'pipe' });
      }
    } catch { /* fall through to direct control */ }
  };
  const svcState = () => {
    try {
      if (service.kind === 'systemd') {
        return execFileSync('systemctl', ['--user', 'is-active', service.name], { stdio: 'pipe' }).toString().trim();
      }
      execFileSync('schtasks', ['/Query', '/TN', service.name], { stdio: 'pipe' });
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
    if (service) { svc('stop'); } else { stop(); }
  } else if (sub === 'status') {
    const up = await health();
    if (up && !alive) { const adopted = adoptPortHolder(); if (adopted) { pid = adopted; alive = true; } }
    const via = service ? `${service.kind}:${svcState()}` : 'process';
    console.log(up ? `running (pid ${pid || 'unknown'}, ${via})` : `stopped (${via})`);
    if (up) {
      try {
        const h = await (await fetch(`http://127.0.0.1:${config.port}/health`)).json();
        console.log(JSON.stringify(h));
      } catch { console.log('health: unreachable'); }
    } else if (!alive) {
      process.exitCode = 1;
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
    console.log('usage: glm-bridge [start|stop|restart|status|logs [n]|run]');
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
        if (IS_WIN) execFileSync('taskkill', ['/PID', String(t), '/T', '/F'], { stdio: 'pipe' });
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
  if (sub === 'status' || sub === 'start' || sub === 'restart' || sub === 'stop' || sub === 'logs' || sub === 'help' || sub === '--help' || sub === '-h') {
    await ctl();
    return;
  }
  console.error(`unknown command: ${sub}`);
  process.exitCode = 1;
}

function boot() {
  writePid(process.pid);
  loadTokens();
  saveTokens();
  ensureTokens();
  getClient(); // start the ZCode CLI immediately so /health is meaningful

  server.listen(config.port, '127.0.0.1', () => {
    log(`glm-bridge listening on http://127.0.0.1:${config.port}/v1 (key: ${config.key})`);
  });

  setInterval(() => { if (tokens.length < 8) ensureTokens(); }, 5 * 60_000);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('shutting down');
      try { if (client) { getClient().child && client.child.kill('SIGTERM'); } } catch { /* ignore */ }
      try { fs.rmSync(PID_PATH, { force: true }); } catch {}
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
