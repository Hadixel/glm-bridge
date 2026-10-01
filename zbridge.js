#!/usr/bin/env node
/*
 * zbridge — global entry point for glm-bridge.
 *
 *   zbridge            open the mini TUI (status, accounts, login/logout, …)
 *   zbridge <args...>  same as glm-bridge <args...> (start/stop/status/…)
 *
 * The TUI is a plain readline menu — no dependencies, works over ssh.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const BRIDGE = path.join(__dirname, 'glm-bridge.js');

const argv = process.argv.slice(2);
if (argv.length) {
  const p = spawn(process.execPath, [BRIDGE, ...argv], { stdio: 'inherit' });
  p.on('exit', c => { process.exit(c || 0); });
} else {
  tui();
}

// Async with a hard timeout: a wedged child (hung schtasks/fetch on Windows)
// must never freeze the menu — blocking execFileSync did exactly that.
function sh(args, timeoutMs = 60_000) {
  return new Promise(res => {
    console.log(`… ${args.join(' ')}`);
    let out = '';
    let done = false;
    const finish = (code) => {
      if (done) return; done = true;
      clearTimeout(t);
      const s = out.trim();
      res(s || (code ? `(command failed, exit ${code})` : 'ok'));
    };
    const p = spawn(process.execPath, [BRIDGE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { out += '\n[timed out — command killed]'; try { p.kill('SIGKILL'); } catch { /* gone */ }
      finish(-1); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', e => { out += e.message; finish(1); });
    p.on('exit', c => finish(c || 0));
  });
}

async function tui() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Own line queue instead of rl.question: lines typed while an `await` is in
  // flight (health fetch, command run) are emitted with no listener attached
  // and rl.question silently swallows them — input used to just vanish.
  const lines = [];
  let waiter = null;
  let closed = false;
  rl.on('line', line => {
    if (waiter) { const w = waiter; waiter = null; w(line); }
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    if (waiter) { const w = waiter; waiter = null; w(null); }
  });
  const ask = q => new Promise(res => {
    process.stdout.write(q);
    if (lines.length) return res(lines.shift());
    if (closed) return res(null);   // real EOF: no more input will ever come
    waiter = res;
  });

  for (;;) {
    console.clear();
    const health = await fetchHealth();
    console.log('╔════════════════════ zbridge ════════════════════╗');
    if (health) {
      console.log(`║ bridge : ${health.ready ? 'READY' : 'starting…'}   account: ${health.account}` +
        ` (${health.accounts})`);
      console.log(`║ cli    : ${health.cliRunning ? 'running' : 'DOWN'}   credentials: ${health.credentials ? 'ok' : 'MISSING'}` +
        (health.detail ? `\n║ note   : ${health.detail}` : ''));
    } else {
      console.log('║ bridge : stopped');
    }
    console.log('╟──────────────────────────────────────────────────╢');
    console.log('║ 1) start   2) stop    3) restart   4) status      ║');
    console.log('║ 5) accounts (list/switch)                        ║');
    console.log('║ 6) login (new/existing account, terminal OAuth)  ║');
    console.log('║ 7) logout                                         ║');
    console.log('║ 8) claim daily plan now                           ║');
    console.log('║ 9) logs (last 30)                                 ║');
    console.log('║ a) tray   b) auto-start toggle   q) quit TUI      ║');
    console.log('╚══════════════════════════════════════════════════╝');
    const raw = await ask('> ');
    if (raw === null || raw.trim().toLowerCase() === 'q') break;
    const choice = raw.trim().toLowerCase();
    if (choice === '1') { console.log(await sh(['start'])); await pause(ask); }
    else if (choice === '2') { console.log(await sh(['stop'])); await pause(ask); }
    else if (choice === '3') { console.log(await sh(['restart'])); await pause(ask); }
    else if (choice === '4') { console.log(await sh(['status'])); await pause(ask); }
    else if (choice === '5') {
      console.log(await sh(['accounts']));
      const n = (await ask('use account (name, empty=skip): ')).trim();
      if (n) console.log(await sh(['use', n]));
      await pause(ask);
    } else if (choice === '6') {
      const n = (await ask('account name (empty = active): ')).trim();
      // login streams to this terminal: the OAuth URL must be visible
      await new Promise(res => {
        const p = spawn(process.execPath, [BRIDGE, 'login', ...(n ? [n] : [])], { stdio: 'inherit' });
        p.on('exit', res);
      });
      await pause(ask);
    } else if (choice === '7') {
      console.log(await sh(['accounts']));
      const n = (await ask('logout which account (name, empty = active): ')).trim();
      console.log(await sh(['logout', ...(n ? [n] : [])]));
      await pause(ask);
    } else if (choice === '8') {
      // minting a captcha can take minutes on first try
      console.log(await sh(['claim'], 15 * 60_000));
      await pause(ask);
    } else if (choice === '9') {
      console.log(await sh(['logs', '30']));
      await pause(ask);
    } else if (choice === 'a') { console.log(await sh(['tray'])); await pause(ask); }
    else if (choice === 'b') { console.log('auto-start: ' + await sh(['autostart-toggle'])); await pause(ask); }
  }
  rl.close();
}

async function pause(ask) { await ask('press enter…'); }

async function fetchHealth() {
  let port = 3010;
  try {
    const home = process.env.GLM_BRIDGE_HOME || path.join(os.homedir(), '.glm-bridge');
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    if (c.port) port = c.port;
  } catch { /* default */ }
  // dev checkout keeps config next to this script
  if (!fs.existsSync(path.join(process.env.GLM_BRIDGE_HOME || path.join(os.homedir(), '.glm-bridge'), 'config.json'))) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
      if (c.port) port = c.port;
    } catch { /* default */ }
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch { return null; }
}
