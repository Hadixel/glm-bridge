#!/usr/bin/env node
/*
 * zbridge — modern TUI and CLI wrapper for glm-bridge.
 *
 *   zbridge            open the interactive control dashboard
 *   zbridge <args...>  forward command directly to glm-bridge
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const BRIDGE = path.join(__dirname, 'glm-bridge.js');

// Direct CLI passthrough when arguments are provided
const argv = process.argv.slice(2);
if (argv.length) {
  const p = spawn(process.execPath, [BRIDGE, ...argv], { stdio: 'inherit' });
  p.on('exit', c => { process.exit(c || 0); });
} else {
  tui();
}

// ------------------------------------------------------------------- Colors --
const isTTY = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  italic: isTTY ? '\x1b[3m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red: isTTY ? '\x1b[31m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  gray: isTTY ? '\x1b[90m' : '',
  bgCyan: isTTY ? '\x1b[46m\x1b[30m' : '',
  bgGreen: isTTY ? '\x1b[42m\x1b[30m' : '',
  bgRed: isTTY ? '\x1b[41m\x1b[37m' : '',
  bgYellow: isTTY ? '\x1b[43m\x1b[30m' : '',
};

// ----------------------------------------------------------- Command Runner --
function sh(args, timeoutMs = 60_000) {
  return new Promise(res => {
    let out = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      const s = out.trim();
      res(s || (code ? `(exit code ${code})` : 'OK'));
    };
    const p = spawn(process.execPath, [BRIDGE, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const t = setTimeout(() => {
      out += `\n${c.red}[timed out after ${timeoutMs / 1000}s]${c.reset}`;
      try { p.kill('SIGKILL'); } catch {}
      finish(-1);
    }, timeoutMs);

    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', e => { out += e.message; finish(1); });
    p.on('exit', c => finish(c || 0));
  });
}

// ------------------------------------------------------------- State Loader --
function getStateDir() {
  return process.env.GLM_BRIDGE_HOME || (
    fs.existsSync(path.join(os.homedir(), '.glm-bridge', 'config.json'))
      ? path.join(os.homedir(), '.glm-bridge')
      : __dirname
  );
}

function loadAccountsData() {
  const p = path.join(getStateDir(), 'accounts.json');
  try {
    const a = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (a && Array.isArray(a.accounts)) return a;
  } catch {}
  return { active: 'main', accounts: [{ name: 'main', dir: os.homedir() }] };
}

async function fetchHealth() {
  let port = 3010;
  try {
    const p = path.join(getStateDir(), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg.port) port = cfg.port;
  } catch {}
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- UI Dashboard ---
async function tui() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Persistent line queue so fast typing or background awaits never drop keystrokes
  const lines = [];
  let waiter = null;
  let closed = false;

  rl.on('line', line => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      lines.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });

  const ask = (promptText = '') => new Promise(res => {
    if (promptText) process.stdout.write(promptText);
    if (lines.length) return res(lines.shift());
    if (closed) return res(null);
    waiter = res;
  });

  const pause = async (msg = 'Press Enter to continue...') => {
    await ask(`\n${c.dim}${msg}${c.reset}`);
  };

  for (;;) {
    console.clear();

    const health = await fetchHealth();
    const accountsData = loadAccountsData();
    const activeAcc = accountsData.accounts.find(x => x.name === accountsData.active) || accountsData.accounts[0];
    const autostartState = await sh(['autostart'], 3000);
    const autostartOn = autostartState.trim() === 'on';

    // 1. App Header & Status Card
    const width = Math.min(process.stdout.columns || 72, 80);
    const hr = '─'.repeat(width);

    console.log(`${c.cyan}${c.bold}  GLM BRIDGE  ${c.reset}${c.dim}· OpenAI/Anthropic gateway for ZCode GLM${c.reset}`);
    console.log(`${c.gray}${hr}${c.reset}`);

    // Status indicator
    if (health) {
      const isReady = health.ready;
      const statusBadge = isReady
        ? `${c.green}${c.bold}● ACTIVE${c.reset} ${c.dim}(port 3010)${c.reset}`
        : `${c.yellow}${c.bold}▲ STARTING${c.reset}`;
      const cliBadge = health.cliRunning
        ? `${c.green}running${c.reset}`
        : `${c.red}stopped${c.reset}`;
      const credBadge = health.credentials
        ? `${c.green}authenticated${c.reset}`
        : `${c.red}missing credentials${c.reset}`;

      console.log(`  ${c.bold}Service:${c.reset}  ${statusBadge}        ${c.bold}Engine:${c.reset} ${cliBadge}    ${c.bold}Auth:${c.reset} ${credBadge}`);
      const quotaBadge = health.quotaLeft
        ? `${c.green}${c.bold}${health.quotaLeft}${c.reset}`
        : (health.quota === 'drained' ? `${c.red}${c.bold}drained${c.reset}` : `${c.green}ok${c.reset}`);
      const routingMode = (health.routing || 'round-robin');
      const routingBadge = routingMode === 'round-robin'
        ? `${c.cyan}${c.bold}Round-Robin (Auto-balanced)${c.reset}`
        : `${c.yellow}${c.bold}Fill-First (Auto-failover)${c.reset}`;
      console.log(`  ${c.bold}Routing:${c.reset}  ${routingBadge}        ${c.bold}Quota Left:${c.reset} ${quotaBadge}`);
      console.log(`  ${c.bold}Account:${c.reset}  ${c.cyan}${c.bold}★ ${health.account || activeAcc.name}${c.reset} ${c.dim}(${health.accounts || accountsData.accounts.length} registered)${c.reset}`);
      if (health.modelQuotas && Object.keys(health.modelQuotas).length) {
        console.log(`  ${c.bold}Models:${c.reset}`);
        for (const [mName, mData] of Object.entries(health.modelQuotas)) {
          const mLabel = mData.label || mData.remainingFormatted;
          console.log(`    ${c.cyan}• ${mName.padEnd(16)}${c.reset} ${c.green}${c.bold}${mLabel}${c.reset}`);
        }
      } else if (health.quotaSummary) {
        console.log(`  ${c.bold}Pool:${c.reset}     ${c.dim}${health.quotaSummary}${c.reset}`);
      }

      if (health.detail) {
        console.log(`  ${c.yellow}${c.dim}Note:     ${health.detail}${c.reset}`);
      }
    } else {
      console.log(`  ${c.bold}Service:${c.reset}  ${c.red}${c.bold}○ STOPPED${c.reset} ${c.dim}(port 3010 not listening)${c.reset}`);
      console.log(`  ${c.bold}Account:${c.reset}  ${c.cyan}★ ${activeAcc.name}${c.reset} ${c.dim}(offline)${c.reset}`);
    }

    // Quota alert banner if drained
    if (health && health.quota === 'drained') {
      console.log(`\n  ${c.bgYellow}${c.bold}  QUOTA DRAINED  ${c.reset} ${c.yellow}Active account 100M plan is exhausted.${c.reset}`);
      if (health.action) {
        console.log(`  ${c.dim}${health.action}${c.reset}`);
      }
    }

    console.log(`${c.gray}${hr}${c.reset}`);

    // 2. Grouped Menu
    console.log(`  ${c.bold}${c.blue}Service Controls${c.reset}`);
    console.log(`   ${c.cyan}[1]${c.reset} Status       ${c.cyan}[2]${c.reset} Start        ${c.cyan}[3]${c.reset} Stop         ${c.cyan}[4]${c.reset} Restart`);
    console.log('');
    console.log(`  ${c.bold}${c.magenta}Accounts & Load Balancing${c.reset} ${c.dim}(mode: ${health?.routing || 'round-robin'}, active: ${activeAcc.name})${c.reset}`);
    console.log(`   ${c.cyan}[5]${c.reset} Accounts & status    ${c.cyan}[r]${c.reset} Toggle routing ${health?.routing === 'fill-first' ? `${c.yellow}(Fill-First)${c.reset}` : `${c.cyan}(Round-Robin)${c.reset}`}`);
    console.log(`   ${c.cyan}[6]${c.reset} Log in new account ${c.dim}(terminal OAuth)${c.reset}   ${c.cyan}[7]${c.reset} Log out account`);
    console.log('');
    console.log(`  ${c.bold}${c.green}Models & Plan Claims${c.reset}`);
    console.log(`   ${c.cyan}[8]${c.reset} Claim daily plan ${c.dim}(100M/account)${c.reset}     ${c.cyan}[9]${c.reset} View models & 9router info`);
    console.log('');
    console.log(`  ${c.bold}${c.yellow}System & Diagnostics${c.reset}`);
    console.log(`   ${c.cyan}[l]${c.reset} Tail logs ${c.dim}(last 30)${c.reset}  ${c.cyan}[t]${c.reset} Launch system tray   ${c.cyan}[a]${c.reset} Toggle autostart ${autostartOn ? `${c.green}(ON)${c.reset}` : `${c.red}(OFF)${c.reset}`}`);
    console.log('');
    console.log(`   ${c.dim}[q] Exit zbridge${c.reset}`);
    console.log(`${c.gray}${hr}${c.reset}`);

    // 3. User Input
    const raw = await ask(`  ${c.cyan}${c.bold}>${c.reset} Select option: `);
    if (raw === null) break;
    const choice = raw.trim().toLowerCase();
    if (choice === 'q' || choice === 'exit') break;

    console.log('');

    // 4. Action Handlers
    if (choice === '1') {
      console.log(`${c.dim}Fetching full status...${c.reset}`);
      const res = await sh(['status']);
      console.log(`\n${c.bold}Status Output:${c.reset}\n${res}`);
      await pause();
    } else if (choice === '2') {
      console.log(`${c.dim}Starting bridge service...${c.reset}`);
      const res = await sh(['start']);
      console.log(`\n${c.green}${res}${c.reset}`);
      await pause();
    } else if (choice === '3') {
      console.log(`${c.dim}Stopping bridge service...${c.reset}`);
      const res = await sh(['stop']);
      console.log(`\n${c.yellow}${res}${c.reset}`);
      await pause();
    } else if (choice === '4') {
      console.log(`${c.dim}Restarting bridge service...${c.reset}`);
      const res = await sh(['restart']);
      console.log(`\n${c.green}${res}${c.reset}`);
      await pause();
    } else if (choice === '5') {
      // Accounts list and switcher
      console.log(`${c.bold}${c.magenta}Registered Accounts:${c.reset}\n`);
      const rawAccounts = await sh(['accounts']);
      const parsed = accountsData.accounts.map(acc => {
        const credFile = path.join(acc.dir, '.zcode', 'v2', 'credentials.json');
        const hasCreds = fs.existsSync(credFile);
        const isActive = acc.name === accountsData.active;
        return { ...acc, hasCreds, isActive };
      });

      console.log(`   ${c.dim}Name            Status          Quota           Directory${c.reset}`);
      console.log(`   ${c.gray}${'─'.repeat(width - 6)}${c.reset}`);
      for (const a of parsed) {
        const mark = a.isActive ? `${c.green}${c.bold}★ ${a.name.padEnd(12)}${c.reset}` : `  ${a.name.padEnd(12)}`;
        const itemInfo = (health?.accountsList || []).find(x => x.name === a.name);
        const status = !a.hasCreds ? `${c.yellow}○ No creds     ${c.reset}`
          : itemInfo?.exhausted ? `${c.red}● Exhausted    ${c.reset}`
          : `${c.green}● Active       ${c.reset}`;
        const qStr = (itemInfo?.quotaLeft || '–').padEnd(14);
        console.log(`  ${mark}  ${status}  ${c.cyan}${qStr}${c.reset}  ${c.dim}${a.dir}${c.reset}`);
      }
      console.log('');

      const target = (await ask(`  ${c.cyan}>${c.reset} Enter account name to switch to ${c.dim}(or press Enter to cancel)${c.reset}: `)).trim();
      if (target) {
        console.log(`\n${c.dim}Switching active account to "${target}"...${c.reset}`);
        const res = await sh(['use', target]);
        console.log(`${c.green}${res}${c.reset}`);
      }
      await pause();
    } else if (choice === 'r') {
      const cur = health?.routing || 'round-robin';
      const target = cur === 'round-robin' ? 'fill-first' : 'round-robin';
      console.log(`${c.dim}Switching routing mode from ${cur} to ${target}...${c.reset}`);
      const res = await sh(['routing', target]);
      console.log(`\n${c.green}${res}${c.reset}`);
      await pause();
    } else if (choice === '6') {
      // New account login
      console.log(`${c.bold}Add & Log In New ZCode Account${c.reset}`);
      console.log(`${c.dim}This runs OAuth in your terminal — no ZCode GUI required.${c.reset}\n`);

      const name = (await ask(`  ${c.cyan}>${c.reset} Choose an account name/label ${c.dim}(e.g. work, alt2)${c.reset}: `)).trim();
      if (!name) {
        console.log(`${c.yellow}Cancelled.${c.reset}`);
        await pause();
        continue;
      }

      console.log(`\n${c.dim}Starting OAuth login for "${name}"...${c.reset}\n`);
      await new Promise(res => {
        const p = spawn(process.execPath, [BRIDGE, 'login', name], { stdio: 'inherit' });
        p.on('exit', res);
      });
      await pause();
    } else if (choice === '7') {
      // Account logout
      console.log(`${c.bold}Log Out / Remove Account${c.reset}\n`);
      for (const a of accountsData.accounts) {
        console.log(`   • ${c.cyan}${a.name}${c.reset} ${c.dim}(${a.dir})${c.reset}`);
      }
      console.log('');
      const name = (await ask(`  ${c.cyan}>${c.reset} Enter account name to log out ${c.dim}(or press Enter to cancel)${c.reset}: `)).trim();
      if (name) {
        const res = await sh(['logout', name]);
        console.log(`\n${c.yellow}${res}${c.reset}`);
      }
      await pause();
    } else if (choice === '8') {
      // Claim daily plan
      console.log(`${c.bold}${c.green}Claim Daily 100M Token Plans${c.reset}`);
      console.log(`${c.dim}Running claim across all logged-in accounts (discovering active offers)...${c.reset}\n`);
      const res = await sh(['claim'], 15 * 60_000);
      console.log(`\n${res}`);
      await pause();
    } else if (choice === '9') {
      // Models overview
      console.log(`${c.bold}${c.cyan}Model Catalog & Routing${c.reset}`);
      console.log(`   ${c.gray}${'─'.repeat(width - 6)}${c.reset}`);
      console.log(`   ${c.bold}Model ID${c.reset}         ${c.bold}Target Engine${c.reset}       ${c.bold}Status${c.reset}`);
      console.log(`   ${c.gray}${'─'.repeat(width - 6)}${c.reset}`);
      const mq = health?.modelQuotas || {};
      const flashQuota = mq['GLM-5.3-Flash']?.label || 'Start Plan 100M';
      const glmQuota = mq['GLM-5.3']?.label || '3M Daily';
      console.log(`   ${c.cyan}glm-5.3-flash${c.reset}    GLM-5.3-Flash       ${c.green}● Native (${flashQuota})${c.reset}`);
      console.log(`   ${c.cyan}glm-5.3${c.reset}          GLM-5.3             ${c.green}● Active (${glmQuota})${c.reset}`);
      console.log(`   ${c.dim}glm-5.2${c.reset}          GLM-5.2             ${c.dim}○ Alias${c.reset}`);
      console.log(`   ${c.dim}glm-5-turbo${c.reset}      GLM-5-Turbo         ${c.dim}○ Alias${c.reset}`);
      console.log('');
      console.log(`   ${c.bold}9router Integration:${c.reset}`);
      console.log(`   • Prefix:        ${c.cyan}glmz${c.reset}`);
      console.log(`   • 9router IDs:   ${c.green}glmz/glm-5.3-flash${c.reset}, ${c.green}glmz/glm-5.3${c.reset}`);
      console.log(`   • Base URL:      ${c.dim}http://127.0.0.1:3010/v1${c.reset}`);
      console.log(`   • Direct curl:   ${c.dim}curl http://127.0.0.1:3010/v1/chat/completions${c.reset}`);
      await pause();
    } else if (choice === 'l' || choice === 'logs') {
      // Logs viewer
      console.log(`${c.bold}Recent Bridge Logs (last 30 lines):${c.reset}`);
      console.log(`   ${c.gray}${'─'.repeat(width - 6)}${c.reset}`);
      const rawLogs = await sh(['logs', '30']);
      const formatted = rawLogs.split('\n').map(line => {
        if (/error/i.test(line)) return `${c.red}${line}${c.reset}`;
        if (/claim/i.test(line)) return `${c.green}${line}${c.reset}`;
        if (/rotate|account/i.test(line)) return `${c.cyan}${line}${c.reset}`;
        return `${c.dim}${line}${c.reset}`;
      }).join('\n');
      console.log(formatted || `${c.dim}No logs available yet.${c.reset}`);
      await pause();
    } else if (choice === 't' || choice === 'tray') {
      console.log(`${c.dim}Starting system tray helper...${c.reset}`);
      const res = await sh(['tray']);
      console.log(`\n${c.green}${res}${c.reset}`);
      await pause();
    } else if (choice === 'a' || choice === 'autostart') {
      console.log(`${c.dim}Toggling system autostart...${c.reset}`);
      const res = await sh(['autostart-toggle']);
      console.log(`\nAutostart is now: ${res.includes('on') ? `${c.green}${c.bold}ON${c.reset}` : `${c.red}${c.bold}OFF${c.reset}`}`);
      await pause();
    }
  }

  // Cleanup on exit
  rl.close();
  console.log(`\n${c.dim}Goodbye!${c.reset}\n`);
}
