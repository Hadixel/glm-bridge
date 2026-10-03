#!/usr/bin/env python3
"""
glm-bridge system tray for Linux (GNOME, Ubuntu, KDE, XFCE, Wayland).
Uses AyatanaAppIndicator3 / AppIndicator3 over DBus (StatusNotifierItem),
which renders natively in the top bar/system tray across modern Linux desktops.

Options:
  - Auto-start toggle (enables/disables systemd/desktop autostart)
  - Quit (terminates the entire bridge service and tray)
"""

import os
import sys
import json
import signal
import subprocess
import urllib.request

# Detect state directory
STATE_DIR = os.environ.get('GLM_BRIDGE_HOME') or os.path.dirname(os.path.abspath(__file__))
PID_FILE = os.path.join(STATE_DIR, 'tray.pid')
LOG_FILE = os.path.join(STATE_DIR, 'tray.log')

def log(msg):
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(f"[tray.py] {msg}\n")
    except Exception:
        pass

# Ensure single instance
if os.path.exists(PID_FILE):
    try:
        with open(PID_FILE, 'r') as f:
            old_pid = int(f.read().strip())
        if old_pid > 0 and old_pid != os.getpid():
            os.kill(old_pid, 0)
            log(f"Another instance ({old_pid}) is already running; exiting")
            sys.exit(0)
    except (ValueError, OSError):
        pass

# Write current PID
try:
    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))
except Exception as e:
    log(f"Failed to write PID file: {e}")

def cleanup(*args):
    try:
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    except Exception:
        pass
    log("Tray exited cleanly")
    sys.exit(0)

signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

# Require display environment
if not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'):
    log("No DISPLAY or WAYLAND_DISPLAY found; exiting")
    cleanup()

# Import GTK and AppIndicator
try:
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, GLib

    AppIndicator = None
    for name in ['AyatanaAppIndicator3', 'AppIndicator3']:
        try:
            gi.require_version(name, '0.1')
            mod = __import__('gi.repository.' + name, fromlist=[name])
            AppIndicator = mod
            log(f"Using {name} for native StatusNotifierItem support")
            break
        except Exception as e:
            log(f"Failed loading {name}: {e}")
            continue

    if not AppIndicator:
        log("Neither AyatanaAppIndicator3 nor AppIndicator3 found; falling back to tray.sh")
        sh_script = os.path.join(STATE_DIR, 'tray.sh')
        if os.path.exists(sh_script):
            os.execv('/bin/sh', ['sh', sh_script])
        cleanup()
except Exception as e:
    log(f"GObject introspection failed: {e}; falling back to tray.sh")
    cleanup()

# Locate CLI
GLM_BIN = os.environ.get('GLM_BRIDGE_BIN')
if not GLM_BIN:
    for cand in ['/home/asd/.local/bin/glm-bridge', os.path.expanduser('~/.local/bin/glm-bridge')]:
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            GLM_BIN = cand
            break
if not GLM_BIN:
    import shutil
    GLM_BIN = shutil.which('glm-bridge')
if not GLM_BIN:
    GLM_BIN = os.path.join(STATE_DIR, 'glm-bridge.sh')

def run_glm(cmd):
    try:
        if os.path.isfile(GLM_BIN) and GLM_BIN.endswith('.js'):
            proc = subprocess.run(['node', GLM_BIN, cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        else:
            proc = subprocess.run([GLM_BIN, cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        return proc.stdout.strip()
    except Exception as e:
        log(f"run_glm({cmd}) failed: {e}")
        return ''

def get_bridge_port():
    try:
        cfg = os.path.join(STATE_DIR, 'config.json')
        with open(cfg, 'r') as f:
            return json.load(f).get('port', 3010)
    except Exception:
        return 3010

class GLMTray:
    def __init__(self):
        self.port = get_bridge_port()
        self.indicator = AppIndicator.Indicator.new(
            "glm-bridge-indicator",
            "preferences-system",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS
        )
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)

        self.menu = Gtk.Menu()

        # Title & status label
        self.title_item = Gtk.MenuItem(label="GLM Bridge (Initializing...)")
        self.title_item.set_sensitive(False)
        self.menu.append(self.title_item)

        self.account_item = Gtk.MenuItem(label="")
        self.account_item.set_sensitive(False)
        self.menu.append(self.account_item)
        self.models_item = Gtk.MenuItem(label="")
        self.models_item.set_sensitive(False)
        self.menu.append(self.models_item)

        self.quota_item = Gtk.MenuItem(label="")
        self.quota_item.set_sensitive(False)
        self.menu.append(self.quota_item)
        self.menu.append(Gtk.SeparatorMenuItem())

        # Auto-start toggle item
        self.autostart_item = Gtk.CheckMenuItem(label="Auto-start with system")
        self.is_updating_autostart = True
        is_on = run_glm('autostart').lower() == 'on'
        self.autostart_item.set_active(is_on)
        self.is_updating_autostart = False
        self.autostart_item.connect("toggled", self.on_autostart_toggled)
        self.menu.append(self.autostart_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        # Quit item (terminates entire service)
        quit_item = Gtk.MenuItem(label="Quit GLM Bridge (Terminate)")
        quit_item.connect("activate", self.on_quit)
        self.menu.append(quit_item)

        self.menu.show_all()
        self.indicator.set_menu(self.menu)

        # Periodic health & status updater (every 5 seconds)
        GLib.timeout_add_seconds(5, self.update_status)
        self.update_status()

    def update_status(self):
        # Track last label so we can force a panel repaint when it changes:
        # some AppIndicator panel implementations only re-read XAyatanaLabel
        # when the icon/status is touched alongside the property update.
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}/health")
            with urllib.request.urlopen(req, timeout=2) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                if data.get('ready'):
                    self.title_item.set_label("● GLM Bridge (Active)")
                    acc = data.get('account', 'default')
                    total = data.get('accounts', 1)
                    routing = data.get('routing', 'round-robin')
                    quota_left = data.get('quotaLeft')
                    quota_summary = data.get('quotaSummary')
                    acc_list = data.get('accountsList') or []

                    if quota_left:
                        new_label = f" {quota_left}"
                        if getattr(self, '_last_label', None) != new_label:
                            self._last_label = new_label
                            try:
                                # Nudge the panel: toggle status so it re-reads
                                # the label property, then apply the new label.
                                self.indicator.set_status(AppIndicator.IndicatorStatus.PASSIVE)
                                self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
                            except Exception:
                                pass
                            try:
                                self.indicator.set_label(new_label, "GLM Bridge Quota")
                            except Exception:
                                pass
                        mode_str = "Round-Robin" if routing == 'round-robin' else "Fill-First"
                        self.account_item.set_label(f"  {mode_str} ({total} accounts) · Quota: {quota_left}")
                    else:
                        quota = data.get('quota', 'ok')
                        self.account_item.set_label(f"  Account: {acc} ({total} active) · Quota: {quota}")
                    self.account_item.show()

                    model_quotas = data.get('modelQuotas') or {}
                    if model_quotas:
                        m_parts = []
                        for m_name, m_data in model_quotas.items():
                            short_name = m_name.replace('GLM-', '')
                            lbl = m_data.get('label') or m_data.get('remainingFormatted') or ''
                            m_parts.append(f"{short_name}: {lbl}")
                        self.models_item.set_label(f"  Models: {' · '.join(m_parts)}")
                        self.models_item.show()
                    else:
                        self.models_item.hide()

                    if len(acc_list) > 1:
                        detail_parts = []
                        for a in acc_list:
                            aname = a.get('name')
                            aql = a.get('quotaLeft') or ('exhausted' if a.get('exhausted') else ('active' if a.get('hasCredentials') else 'no creds'))
                            detail_parts.append(f"{aname}: {aql}")
                        self.quota_item.set_label(f"  Pool: {' · '.join(detail_parts)}")
                        self.quota_item.show()
                    elif quota_summary:
                        self.quota_item.set_label(f"  Remaining: {quota_summary}")
                        self.quota_item.show()
                    else:
                        self.quota_item.hide()
                else:
                    self.title_item.set_label("▲ GLM Bridge (Starting...)")
                    try:
                        self.indicator.set_label("", "")
                    except Exception:
                        pass
                    self.account_item.hide()
                    self.models_item.hide()
                    self.quota_item.hide()
        except Exception:
            self.title_item.set_label("○ GLM Bridge (Stopped)")
            try:
                self.indicator.set_label("", "")
            except Exception:
                pass
            self.account_item.hide()
            self.models_item.hide()
            self.quota_item.hide()
        return True  # Keep timer running

    def on_autostart_toggled(self, widget):
        if self.is_updating_autostart:
            return
        new_state = run_glm('autostart-toggle').lower()
        self.is_updating_autostart = True
        widget.set_active(new_state == 'on')
        self.is_updating_autostart = False
        log(f"Autostart toggled -> {new_state}")

    def on_quit(self, widget):
        log("Quit clicked -> terminating bridge and tray")
        # Run quit to shut down the bridge and cleanup
        run_glm('quit')
        cleanup()

if __name__ == '__main__':
    log("Starting GLM Bridge native tray...")
    try:
        tray = GLMTray()
        Gtk.main()
    except Exception as e:
        log(f"Unhandled exception in tray: {e}")
        cleanup()
