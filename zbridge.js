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
const { spawn, execFileSync } = require('child_process');

const BRIDGE = path.join(__dirname, 'glm-bridge.js');

const argv = process.argv.slice(2);
if (argv.length) {
  const p = spawn(process.execPath, [BRIDGE, ...argv], { stdio: 'inherit' });
  p.on('exit', c => { process.exit(c || 0); });
} else {
  tui();
}

function sh(cmd, args) {
  try { return execFileSync(process.execPath, [BRIDGE, ...args], { encoding: 'utf8' }).trim(); }
  catch (e) { return String(e.stdout || e.message || '').trim(); }
}

async function tui() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });
  const ask = q => new Promise(res => {
    if (closed) return res('q');
    rl.question(q, ans => res(ans));
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
    const choice = (await ask('> ')).trim().toLowerCase();
    if (closed || choice === 'q') break;
    else if (choice === '1') console.log(sh('start', ['start']));
    else if (choice === '2') console.log(sh('stop', ['stop']));
    else if (choice === '3') console.log(sh('restart', ['restart']));
    else if (choice === '4') console.log(sh('status', ['status']));
    else if (choice === '5') {
      console.log(sh('accounts', ['accounts']));
      const n = (await ask('use account (name, empty=skip): ')).trim();
      if (n) console.log(sh('use', ['use', n]));
      await pause(rl, ask);
    } else if (choice === '6') {
      const n = (await ask('account name (empty = active): ')).trim();
      // login streams to this terminal: the OAuth URL must be visible
      await new Promise(res => {
        const p = spawn(process.execPath, [BRIDGE, 'login', ...(n ? [n] : [])], { stdio: 'inherit' });
        p.on('exit', res);
      });
      await pause(rl, ask);
    } else if (choice === '7') {
      console.log(sh('accounts', ['accounts']));
      const n = (await ask('logout which account (name, empty = active): ')).trim();
      console.log(sh('logout', ['logout', ...(n ? [n] : [])]));
      await pause(rl, ask);
    } else if (choice === '8') {
      console.log(sh('claim', ['claim']));
      await pause(rl, ask);
    } else if (choice === '9') {
      console.log(sh('logs', ['logs', '30']));
      await pause(rl, ask);
    } else if (choice === 'a') { console.log(sh('tray', ['tray'])); await pause(rl, ask); }
    else if (choice === 'b') { console.log('auto-start: ' + sh('toggle', ['autostart-toggle'])); await pause(rl, ask); }
  }
  rl.close();
}

async function pause(rl, ask) { await ask('press enter…'); }

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
