import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  desktopCapturer,
  screen,
  Tray,
  Menu,
  nativeImage
} from 'electron';
import { SyncServer } from './sync-server';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec, execFile, execFileSync, spawn } from 'child_process';
import si from 'systeminformation';
import os from 'os';
import { listSkills, readSkillFrom, syncSkills, DEFAULT_SKILL_SOURCES } from './skills';

// Opt-in DevTools protocol port, for driving the running app from a script
// (`BEN_CDP_PORT=9222 npm run dev`). Off unless asked for: an open debugging
// port is a remote-code channel into the renderer, so it must never be on in a
// packaged build or by default in dev.
if (process.env.BEN_CDP_PORT && !app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.BEN_CDP_PORT);
  app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1:' + process.env.BEN_CDP_PORT);
}

// Wayland will not let a client place its own window - the compositor decides -
// and the notch is a pill that has to sit at a specific point at the top of the
// screen. Under Wayland `setBounds` was accepted and ignored, so it appeared
// wherever GNOME or Hyprland felt like putting it, which is what "the notch is
// not properly placed" is. Measured on GNOME 4x Wayland here.
//
// XWayland has the X11 window management the rest of this app was written
// against: positioning, always-on-top and click-through all work. So on Linux
// under Wayland, ask for x11 unless told otherwise:
//
//   BEN_OZONE=wayland npm run dev    # native Wayland, notch lands where it lands
if (process.platform === 'linux') {
  const requested = (process.env.BEN_OZONE || '').trim();
  if (requested) {
    app.commandLine.appendSwitch('ozone-platform', requested);
    process.env.ELECTRON_OZONE_PLATFORM_HINT = requested;
    // Chromium picks Vulkan here and the GPU process segfaults under XWayland
    // on this driver, which leaves a window that never paints.
    if (requested === 'x11') {
      app.commandLine.appendSwitch('disable-features', 'Vulkan');
      app.disableHardwareAcceleration();
    }
    console.log(`[Platform] ozone-platform=${requested} (BEN_OZONE)`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let notchWindow: BrowserWindow | null = null;

const settingsPath = path.join(app.getPath('userData'), 'jarvis-settings.json');

function loadSavedSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to read settings:', err);
  }
  return {};
}

function saveSettingsData(settings: any) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (err: any) {
    console.error('Failed to save settings:', err);
    return { success: false, error: err.message };
  }
}

// Where the pill sits. `bounds` is the whole display including whatever the
// desktop has reserved at the top of it - a menu bar, a panel, waybar - so on a
// Linux desktop with a top bar the pill was placed underneath it. `workArea` is
// the part actually available to a window.
function notchAnchor(width: number, height: number) {
  const area = screen.getPrimaryDisplay().workArea;
  const topMargin = 12;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + topMargin),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function createNotchWindow() {
  const initialWidth = 220;
  const initialHeight = 36;
  const anchor = notchAnchor(initialWidth, initialHeight);
  const x = anchor.x;
  const y = anchor.y;

  notchWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  notchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 'screen-saver' rather than 'floating': a full-screen window is itself at
  // the floating level, so the pill went behind video and behind anything else
  // claiming always-on-top.
  notchWindow.setAlwaysOnTop(true, 'screen-saver', 1);

  // A title of its own. Both windows load the same bundle, so without this the
  // pill is called "B.E.N. // V.A.U.L.T. Terminal" like the deck - which leaves
  // a compositor rule no way to tell them apart, and is the same ambiguity that
  // made "show me the terminal" match B.E.N.'s own window.
  notchWindow.on('page-title-updated', (event) => event.preventDefault());
  notchWindow.setTitle('B.E.N. Notch');

  // A screen resolution change, a monitor unplugged, a panel appearing: the
  // centre of the work area moves and the pill has to move with it.
  const recentre = () => {
    if (!notchWindow || notchWindow.isDestroyed() || notchHiddenForIdle) return;
    const current = notchWindow.getBounds();
    notchWindow.setBounds(notchAnchor(current.width, current.height));
  };
  screen.on('display-metrics-changed', recentre);
  screen.on('display-added', recentre);
  screen.on('display-removed', recentre);

  if (process.env.VITE_DEV_SERVER_URL) {
    notchWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?mode=notch`);
  } else {
    notchWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { mode: 'notch' } });
  }

  notchWindow.on('closed', () => {
    notchWindow = null;
  });
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.min(1280, Math.round(screenWidth * 0.85));
  const winHeight = Math.min(840, Math.round(screenHeight * 0.88));

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 800,
    minHeight: 600,
    transparent: false,
    backgroundColor: '#07060B',
    // macOS: native traffic lights over a hidden title bar - the same controls
    // everyone already knows, and they keep working when the renderer is busy.
    //
    // Everywhere else that combination leaves a window with NO controls at all:
    // `titleBarStyle: 'hidden'` removes the frame and there are no traffic
    // lights to take its place, so on Linux the deck could not be closed,
    // minimised or maximised. There the window keeps its frame and the header
    // draws its own buttons over the existing IPC.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 18, y: 24 },
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const
        }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    // Mirror renderer logs into the terminal. Audio and WebSocket problems are
    // invisible otherwise, because they only ever surface in DevTools.
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (message.startsWith('[AudioRecorder]') || message.startsWith('[Gemini Live]') || level >= 2) {
        console.log(`[renderer] ${message}`);
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('focus', () => {
    notchWindow?.webContents.send('deck-engaged-change', true);
  });

  mainWindow.on('blur', () => {
    notchWindow?.webContents.send('deck-engaged-change', false);
  });

  mainWindow.on('minimize', () => {
    notchWindow?.webContents.send('deck-engaged-change', false);
  });

  mainWindow.on('restore', () => {
    notchWindow?.webContents.send('deck-engaged-change', true);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (notchWindow && !notchWindow.isDestroyed()) {
      notchWindow.close();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createNotchWindow();
  // The clock starts at launch: a session nobody engages with should not leave
  // the pill sitting there all day either. Armed before the tray, because the
  // tray is the part that can fail on a desktop with no place to put it and
  // hiding must not depend on it.
  armNotchIdleTimer();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createNotchWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Notch IPC Handlers
ipcMain.on('sync-notch-state', (_event, stateData: any) => {
  if (notchWindow && !notchWindow.isDestroyed()) {
    notchWindow.webContents.send('notch-state-update', stateData);
  }
  // The pill comes back for anything happening, and only fades out after a
  // long stretch of nothing at all.
  noteNotchActivity(typeof stateData?.state === 'string' ? stateData.state : undefined);
});

ipcMain.handle('resize-notch', (_event, { width, height }: { width: number; height: number }) => {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  const anchor = notchAnchor(width, height);
  notchWindow.setBounds(anchor);
  // Read the position back. Under Wayland a client cannot place its own
  // windows - the compositor decides - so setBounds is accepted and ignored,
  // and the pill appears wherever the tiling rules put it. Saying so once is
  // the difference between a known limitation and a bug nobody can explain.
  if (process.platform === 'linux') warnIfNotchUnplaced(anchor);
});

let notchPlacementWarned = false;

function warnIfNotchUnplaced(anchor: { x: number; y: number }) {
  if (notchPlacementWarned || !notchWindow || notchWindow.isDestroyed()) return;
  const actual = notchWindow.getBounds();
  if (Math.abs(actual.x - anchor.x) < 8 && Math.abs(actual.y - anchor.y) < 8) return;
  notchPlacementWarned = true;
  console.warn(
    `[Notch] asked for ${anchor.x},${anchor.y} and the compositor put it at ${actual.x},${actual.y}. ` +
      'Under Wayland an application cannot position its own windows - the compositor decides, ' +
      'and setBounds is accepted and ignored. To have the pill where it belongs, start with ' +
      'BEN_OZONE=x11 (XWayland, positions correctly here, at the cost of GPU acceleration). ' +
      'On Hyprland a compositor rule works instead:\n' +
      '  windowrulev2 = float, title:^(B\\.E\\.N\\. Notch)$\n' +
      '  windowrulev2 = move 50% 12, title:^(B\\.E\\.N\\. Notch)$\n' +
      '  windowrulev2 = pin, title:^(B\\.E\\.N\\. Notch)$'
  );
}

// --- The notch in the top panel ---------------------------------------------
//
// The pill is always on screen, which is right while something is happening and
// wrong at three in the morning. After a long idle it hides itself and leaves
// the tray icon in the panel; anything happening brings it back.
//
// Inlined rather than read from disk: the icon has to resolve identically in
// dev (where __dirname is dist-electron) and in a packaged app, and a 1 KB PNG
// is cheaper than getting that wrong.
const TRAY_ICON_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAEGElEQVR4nLWVPWwUVxSFv3dnZmdnPd7gzcbC2i4hGPIjRIVEg6mCSCgsswZEOqI4VIAlcIGEAYnCIBmoiKPQBQFerC1IkFPZaZCoEMoPmEA6y8jZrMl6vLOzM/NeCstKhJwOTvf07vn0rq7eubCOJsvGevU8XTaF6bIprHe3HkOtBx2sqHS0/EvmY3n/gGDtS4zuBd2zWiELtpI5TXr3Z/377XOVj9prnv8Fj2LkHErfLDcPZMQ549r2B9pAO9WkOgbAEoeMJYiCKEl+a+v4/KFK7vaa9xWwUZNlZLCi0pvl8HLOzh5PDYRJkGTEVRnLUaJWa7XBtNPYtHVkPNu3LQXNpHXlUMU7sfpyNCij/tv+jYHm5WKHd7wehokxWjozHbLYXODJX/eZX54DoNTZy5a3d9Kd62G5vaKVEl3wPLu2El45PJU7scZSo7tm7HM/7U5uDbYGcrZ7pxmHMWBnLFf9+Mc3VJ9eYqk1jzarXYoSurIl+jef5JN3v6SdRgZIco7nNJNo/8HJ7NTorhlb6JvV9/YYF63HUq3RRluu5arrj4aZeHiUZvwSP1uk0+6i0+7CzxZpxi+ZeHiU64+GcS1XaaOtVGvQeuzeHuPSN6sVwK39zcO+6333MlxO38p2Wt8/m2Di4Vd0eSW0jtFBA3mnGwD95yLi5xFxWArnGdr+NZ9tGuLv1nK6weu0gij8/OCd3A1ZnaDq1wbj2p5ZXFmg+vQivltAmxidRPgj5+mqztBVncEfOY9OIrSJ8d0C1acXWVxZwLU9ow1GofoBZLJsPK3M1naaqoxly5P6feqteRzbQwcN/GOn6Rg+iRSKSKFIx/BJ/GOn0UEDx/aot+Z5Ur9PxrKlnaZKK7N1smw8seNGzsDG1CSIQs0HcxijMXGMFLvJ7htA1xoQtyFuo2sNsvsGkGI3Jo4xRjMfzCEKlZoEAxvtuJGT9b7j65AkTr6p4IWlbLTBlPxelBKU46Bri7TuTiHFPDgZcDJIMU/r7hS6tohyHJQSSn4v2mAsZaPgReLkmzJYUaEY9ThjWaadJnpLYSeFbIk4CRE/T3D1Aivjl9D1GrpeY2X8EsHVC4ifJ05CCtkSWwo7aaeJzliWEaMeD1ZUKAAGUxWFipJQdXf00L/5FEFUR5SD2C7B2BmW+nez1L+bYOwMYruIcgiiOv2bT9Hd0UOUhEoUymCqAGp0dFR2PDjrNPzwV9d23wuTUHu2J98+GuaHZ1fxMwUcx8PEqyGkHIc4DgnadT7ddIwvto2z5omS6Hk+8D58sONsLMz2yd5pFSEyYokgStIojcyRbeMMbb9GztlA0KqxnCyxnCwRtGrknA0Mbb/GkW3jRGlkRElqiYDIyN5pFTHbJ28uhN5obK7pDQT9v3pdq2ldvY5l+g/SEYW8pp2PjwAAAABJRU5ErkJggg==';

// "Idle for a long time" - long enough that the pill is not flickering away
// between sentences, short enough to be gone when you have walked off.
const NOTCH_IDLE_HIDE_MS = Number(process.env.BEN_NOTCH_IDLE_MS) || 3 * 60 * 1000;

let tray: Tray | null = null;
let notchHiddenForIdle = false;
let notchIdleTimer: ReturnType<typeof setTimeout> | null = null;
// States that mean something is happening. Anything else is the pill sitting
// there saying nothing.
const BUSY_STATES = new Set([
  'listening',
  'thinking',
  'speaking',
  'building',
  'tool_executing',
  'activated',
  'connecting'
]);

function showNotch(reason: string) {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  notchHiddenForIdle = false;
  const bounds = notchWindow.getBounds();
  notchWindow.setBounds(notchAnchor(bounds.width, bounds.height));
  // Re-asserted on every show: a window that has been hidden comes back at
  // whatever level the compositor feels like, and 'screen-saver' outranks the
  // 'floating' level that full-screen windows also use.
  notchWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  notchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!notchWindow.isVisible()) {
    // showInactive, never show: the pill must never take focus from what the
    // user is typing into.
    notchWindow.showInactive();
    console.log(`[Notch] shown (${reason})`);
  }
  tray?.setToolTip('B.E.N.');
}

function hideNotchForIdle() {
  if (!notchWindow || notchWindow.isDestroyed() || notchHiddenForIdle) return;
  notchHiddenForIdle = true;
  notchWindow.hide();
  tray?.setToolTip('B.E.N. — idle, click to show');
  console.log(`[Notch] hidden after ${Math.round(NOTCH_IDLE_HIDE_MS / 1000)}s idle - it is in the panel`);
}

function armNotchIdleTimer() {
  if (notchIdleTimer) clearTimeout(notchIdleTimer);
  notchIdleTimer = setTimeout(() => {
    notchIdleTimer = null;
    hideNotchForIdle();
  }, NOTCH_IDLE_HIDE_MS);
}

// Called whenever the deck pushes a state. A busy state shows the pill and
// resets the clock; an idle one only lets the clock run.
let lastNotchStateSeen = '';

function noteNotchActivity(state?: string) {
  if (state && state !== lastNotchStateSeen) {
    lastNotchStateSeen = state;
    console.log(`[Notch] state ${state}${BUSY_STATES.has(state) ? ' (busy, idle clock reset)' : ' (idle clock running)'}`);
  }
  if (state && BUSY_STATES.has(state)) {
    showNotch(state);
    armNotchIdleTimer();
    return;
  }
  if (!notchIdleTimer) armNotchIdleTimer();
}

// GNOME has no system tray of its own: an icon in the top panel needs the
// AppIndicator extension, which Ubuntu ships but does not always enable. When
// it is off, Electron's Tray constructor still runs and the icon goes nowhere,
// with only `Gtk: gtk_widget_get_scale_factor: assertion 'GTK_IS_WIDGET' failed`
// in the log to say so. Checking first means the app can say what to do about
// it instead of appearing to have no tray for no reason.
function appIndicatorEnabled(): boolean | null {
  if (process.platform !== 'linux') return null;
  if (!/gnome/i.test(process.env.XDG_CURRENT_DESKTOP || '')) return null;
  try {
    const enabled = execFileSync('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions'], {
      timeout: 2500,
      encoding: 'utf8'
    });
    return /appindicator/i.test(enabled);
  } catch {
    return null;
  }
}

function createTray() {
  if (tray) return;

  if (appIndicatorEnabled() === false) {
    console.warn(
      '[Tray] GNOME is running without an AppIndicator extension, so there is nowhere to put a ' +
        'tray icon. The notch will still hide itself when idle and come back when something ' +
        'happens. To get the icon in the top panel:\n' +
        '  gnome-extensions enable ubuntu-appindicators@ubuntu.com'
    );
    return;
  }

  try {
    const icon = nativeImage.createFromDataURL(TRAY_ICON_PNG);
    tray = new Tray(icon);
    tray.setToolTip('B.E.N.');
    console.log('[Tray] icon created');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show B.E.N.',
          click: () => {
            if (!mainWindow) return;
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        },
        {
          label: 'Show the notch',
          click: () => {
            showNotch('tray');
            armNotchIdleTimer();
          }
        },
        {
          label: 'Hide the notch',
          click: () => hideNotchForIdle()
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    );
    // GNOME routes a left click to the menu; other desktops send it here.
    tray.on('click', () => {
      showNotch('tray click');
      armNotchIdleTimer();
    });
  } catch (err: any) {
    // No tray on this desktop (GNOME needs the AppIndicator extension). The
    // notch still works; it just has nowhere to hide to, so leave it up.
    console.warn('[Tray] could not be created, the notch will not auto-hide:', err?.message);
  }
}

ipcMain.handle('notch-action', (_event, action: string) => {
  if (action === 'toggle-deck' || action === 'show-deck') {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  }
});

// IPC Handlers
ipcMain.handle('window-minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.handle('window-close', () => {
  mainWindow?.close();
});

ipcMain.handle('toggle-always-on-top', () => {
  if (!mainWindow) return false;
  const isTop = mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(!isTop);
  return !isTop;
});

ipcMain.handle('is-always-on-top', () => {
  return mainWindow?.isAlwaysOnTop() ?? false;
});

ipcMain.handle('load-settings', () => {
  return loadSavedSettings();
});

ipcMain.handle('save-settings', (_event, settings) => {
  return saveSettingsData(settings);
});

// The browser this machine actually opens links with, by name, so a failure can
// say what was tried rather than "it did not work".
function defaultBrowserName(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const entryFile = execFileSync('xdg-settings', ['get', 'default-web-browser'], {
      timeout: 2500,
      encoding: 'utf8'
    }).trim();
    if (!entryFile) return null;
    const entry = linuxDesktopEntries().find((e) => path.basename(e.file) === entryFile);
    return entry?.name || entryFile.replace(/\.desktop$/, '');
  } catch {
    return null;
  }
}

ipcMain.handle('open-url', async (_event, url: string) => {
  try {
    await shell.openExternal(url);
    // `openExternal` resolving means the request was handed off, not that a
    // browser opened - and B.E.N. announces this result out loud. Read the fact
    // back the same way open-app does: it said it had opened a video and the
    // journal showed nothing ever ran.
    const browser = defaultBrowserName();
    if (browser) {
      await new Promise((r) => setTimeout(r, 1200));
      const running = await appRunningState(browser);
      if (running === 'no') {
        return {
          success: false,
          browser,
          error:
            `The link was handed to ${browser} and it is not running, so nothing opened. Tell ` +
            'the user it did not open rather than saying it did.'
        };
      }
      return { success: true, url, openedIn: browser, verified: running === 'yes' };
    }
    return { success: true, url };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Whether the app is actually running now, asked of the system rather than
// inferred from the launch command exiting cleanly. `open -a` returns success
// for things that then fail to stay up, and B.E.N. reporting "opened" for a
// window that is not there is the worst kind of wrong answer.
// execFile, not exec, everywhere an application name or a path reaches the
// system. These strings are chosen by the model from what it heard, and a name
// containing `$(...)`, a backtick or an apostrophe is a command, not a name:
// double quotes do not stop substitution, and an apostrophe closes the single
// quotes around an AppleScript snippet. execFile passes arguments as arguments,
// so there is no shell to trick.
function appRunningState(appName: string): Promise<'yes' | 'no' | 'unknown'> {
  if (process.platform === 'linux') {
    // pgrep -x, never -f: -f matches whole command lines, and this app's own
    // command line contains the names of things it was asked about.
    const entry = linuxEntryFor(appName);
    const command = entry ? execCommand(entry) : null;
    const bin = path.basename(command?.bin || appName);
    return new Promise((resolve) => {
      execFile('pgrep', ['-x', bin], { timeout: 3000 }, (err, stdout) => {
        if (stdout && stdout.trim()) return resolve('yes');
        // No match is only a "no" when we know which binary to look for.
        resolve(entry ? 'no' : 'unknown');
      });
    });
  }
  if (process.platform !== 'darwin') return Promise.resolve('unknown');
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'application "' + appName.replace(/["\\]/g, '') + '" is running'],
      { timeout: 4000 },
      (err, stdout) => {
        // An error here means AppleScript could not answer the question - some
        // apps are not scriptable by name - which is not the same answer as
        // "no". Reporting "it did not open" for an app that did is the same
        // class of wrong answer as the one this check exists to stop.
        if (err) return resolve('unknown');
        resolve(/true/i.test(stdout || '') ? 'yes' : 'no');
      }
    );
  });
}

function appIsRunning(appName: string): Promise<boolean> {
  return appRunningState(appName).then((state) => state === 'yes');
}

// One launcher, three platforms. `open -a` is macOS only; on Linux an
// application is a .desktop entry launched through gio (which applies the
// entry's environment and field codes correctly) with a direct exec as the
// fallback for anything that has no entry but is on PATH.
function launchApp(appName: string, target?: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const done = (err: any) => resolve(err ? { ok: false, error: err.message } : { ok: true });

    if (process.platform === 'darwin') {
      execFile('open', target ? ['-a', appName, target] : ['-a', appName], done);
      return;
    }

    if (process.platform === 'linux') {
      const entry = linuxEntryFor(appName);
      if (entry) {
        execFile('gio', target ? ['launch', entry.file, target] : ['launch', entry.file], (err) => {
          if (!err) return resolve({ ok: true });
          // gio is not everywhere. Fall back to the entry's own command.
          const command = execCommand(entry);
          if (!command) return done(err);
          execFile(command.bin, target ? [...command.args, target] : command.args, done);
        });
        return;
      }
      // No entry: it may still be a binary on PATH ("code", "nvim").
      const bin = appName.trim().split(/\s+/)[0].toLowerCase();
      execFile(
        bin,
        target ? [target] : [],
        { env: { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` } },
        done
      );
      return;
    }

    execFile('cmd', target ? ['/c', 'start', '', appName, target] : ['/c', 'start', '', appName], done);
  });
}

ipcMain.handle('open-app', async (_event, appName: string) => {
  // The name arrives as it was spoken - "antigravity", "vs code" - and `open -a`
  // wants the bundle name. Resolving against what is installed also means an
  // app that is not here is reported as missing instead of quietly failing.
  // preferEditor here too: "open Antigravity" names two installed apps and the
  // IDE is the one meant. It only changes anything when a name is ambiguous.
  const resolvedName = resolveInstalledApp(appName, true) || appName;

  const launched = await launchApp(resolvedName);
  if (!launched.ok) {
    return {
      success: false,
      error: `Could not open ${resolvedName}: ${launched.error}`,
      installedApps: resolveInstalledApp(appName) ? undefined : installedEditors()
    };
  }

  // Give it a moment to appear, then read the fact back rather than trusting
  // the launch command's exit code.
  await new Promise((r) => setTimeout(r, 900));
  const running = await appRunningState(resolvedName);
  if (running === 'no') {
    return {
      success: false,
      verified: false,
      error:
        `The launch command for ${resolvedName} succeeded but the application is not ` +
        'running. Tell the user it did not open rather than saying it did.'
    };
  }
  return {
    success: true,
    verified: running === 'yes',
    openedIn: resolvedName,
    message: `${resolvedName} is open.`
  };
});

ipcMain.handle('close-app', async (_event, appName: string) => {
  return new Promise((resolve) => {
    const sanitized = appName.replace(/["\\]/g, '');
    if (process.platform === 'darwin') {
      // 1. Try graceful quit via AppleScript
      execFile('osascript', ['-e', `tell application "${sanitized}" to quit`], (err) => {
        if (!err) {
          resolve({ success: true, message: `Closed ${appName}` });
        } else {
          // 2. Fallback to an exact-name kill. Never `pkill -f`: matching the
          // whole command line means "Code" also matches every process with
          // that word anywhere in its arguments, this app included.
          execFile('pkill', ['-x', sanitized], (killErr) => {
            if (!killErr) {
              resolve({ success: true, message: `Terminated ${appName}` });
            } else {
              resolve({ success: false, error: `Could not close ${appName}: ${err.message}` });
            }
          });
        }
      });
    } else if (process.platform === 'linux') {
      // The binary, resolved from the desktop entry - "Visual Studio Code" is a
      // process called `code`. Exact match only, for the reason above.
      const entry = linuxEntryFor(sanitized);
      const command = entry ? execCommand(entry) : null;
      const bin = path.basename(command?.bin || sanitized);
      execFile('pkill', ['-x', bin], (err) => {
        if (!err) {
          resolve({ success: true, message: `Closed ${appName}` });
        } else {
          resolve({
            success: false,
            error:
              `Nothing called ${bin} was running, so ${appName} was not closed. Tell the user ` +
              'that rather than saying you closed it.'
          });
        }
      });
    } else {
      execFile('taskkill', ['/IM', `${sanitized}.exe`, '/F'], (err) => {
        if (err) {
          resolve({ success: false, error: `Could not close ${appName}: ${err.message}` });
        } else {
          resolve({ success: true, message: `Closed ${appName}` });
        }
      });
    }
  });
});

ipcMain.handle('get-system-info', async () => {
  try {
    const [cpu, currentLoad, mem, battery, time] = await Promise.all([
      si.cpu(),
      si.currentLoad(),
      si.mem(),
      si.battery(),
      si.time()
    ]);

    return {
      cpuModel: `${cpu.manufacturer} ${cpu.brand}`,
      cpuCores: cpu.cores,
      cpuLoad: Math.round(currentLoad.currentLoad),
      memoryTotalGb: (mem.total / (1024 ** 3)).toFixed(1),
      memoryUsedGb: (mem.used / (1024 ** 3)).toFixed(1),
      memoryPercent: Math.round((mem.used / mem.total) * 100),
      batteryPercent: battery.hasBattery ? battery.percent : null,
      batteryIsCharging: battery.hasBattery ? battery.isCharging : null,
      uptimeSeconds: time.uptime,
      timezone: time.timezoneName || Intl.DateTimeFormat().resolvedOptions().timeZone
    };
  } catch (err: any) {
    console.error('Failed to get system info:', err);
    return {
      error: err.message,
      cpuLoad: 0,
      memoryPercent: 0
    };
  }
});

// What can be looked at: every display, and every window with a real title.
ipcMain.handle('list-capture-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1, height: 1 }
    });
    return {
      success: true,
      sources: sources
        .filter((s) => s.name && s.name !== 'B.E.N. // V.A.U.L.T. Terminal')
        .map((s) => ({ id: s.id, name: s.name, isScreen: s.id.startsWith('screen:') }))
    };
  } catch (err: any) {
    return { success: false, error: err.message, sources: [] };
  }
});

// Names a window loosely, the way a person does: "chrome", "my editor", "the
// terminal". An exact id wins; otherwise the best-matching title.
function pickSource(sources: Array<{ id: string; name: string }>, target?: string) {
  if (!target || !target.trim()) {
    return sources.find((s) => s.id.startsWith('screen:')) || sources[0];
  }
  const wanted = target.trim().toLowerCase();

  if (/^(screen|desktop|everything|whole screen|entire screen|my screen)$/.test(wanted)) {
    return sources.find((s) => s.id.startsWith('screen:')) || sources[0];
  }

  const exact = sources.find((s) => s.id === target);
  if (exact) return exact;

  // B.E.N.'s own windows are excluded from matching: asking for "the terminal"
  // should find the user's terminal, not the assistant looking at itself. The
  // whole-screen capture still shows everything, including this window.
  const windows = sources.filter(
    (s) => !s.id.startsWith('screen:') && !/B\.E\.N\.|V\.A\.U\.L\.T\./i.test(s.name)
  );
  return (
    windows.find((s) => s.name.toLowerCase() === wanted) ||
    windows.find((s) => s.name.toLowerCase().includes(wanted)) ||
    windows.find((s) => wanted.split(/\s+/).some((word) => word.length > 2 && s.name.toLowerCase().includes(word))) ||
    null
  );
}

ipcMain.handle('capture-screen', async (_event, options?: { target?: string }) => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: {
        width: Math.min(1920, primaryDisplay.size.width),
        height: Math.min(1080, primaryDisplay.size.height)
      }
    });

    if (!sources.length) return { success: false, error: 'No capture source is available.' };

    const chosen = pickSource(sources, options?.target);
    if (!chosen) {
      // Same filter as the matcher, or the model is offered B.E.N.'s own windows
      // as alternatives and the next attempt fails the same way.
      const names = Array.from(
        new Set(
          sources
            .filter((s) => !s.id.startsWith('screen:') && !/B\.E\.N\.|V\.A\.U\.L\.T\./i.test(s.name))
            .map((s) => s.name)
        )
      ).slice(0, 12);
      return {
        success: false,
        error: `No window matching "${options?.target}" is open.`,
        available: names
      };
    }

    const img = (chosen as any).thumbnail;
    if (!img || img.isEmpty()) {
      return { success: false, error: `"${chosen.name}" could not be captured (it may be minimised).` };
    }

    return {
      success: true,
      imageBase64: img.toJPEG(80).toString('base64'),
      mimeType: 'image/jpeg',
      capturedName: chosen.name,
      wasWholeScreen: chosen.id.startsWith('screen:')
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Opencode Auto-Development Integration in /Users/thesulabh/Development
// Workspace root. Overridable so the app is not pinned to one developer's
// home directory.
const DEFAULT_DEV_DIR = process.env.BEN_DEV_DIR || path.join(os.homedir(), 'Development');

// --- System audio detection --------------------------------------------------
// The wake word listener hears the laptop's own speakers as readily as it hears
// the room, so anything said by a video or a track has to be discounted.
//
// macOS grants a power assertion per process that holds an open output context,
// and names the process that created it. Anything holding `audio-out` that is
// not one of our own renderers is another app making noise out of this machine.
//
// Two earlier approaches did not survive contact: the assertion looks like it
// never clears if you ignore the PID, because B.E.N.'s own AudioContext holds
// one for as long as the app runs; and Electron's getDisplayMedia loopback
// returns a "System audio" track that is already `ended` on this macOS build.
const SYSTEM_AUDIO_CACHE_MS = 700;
let systemAudioCache: { at: number; playing: boolean; sources: string[] } = {
  at: 0,
  playing: false,
  sources: []
};

// app.getAppMetrics() does not list every helper - Chromium's audio service is
// its own process and holds an output context of its own, which showed up as a
// foreign app playing music in an otherwise silent room.
//
// Two tests are used together. Ancestry catches every child of this process
// whatever Chromium calls it, and the bundle path catches a second copy of
// B.E.N. left running, which is not our child but is still not "the laptop
// playing something at the user".
const OWN_BUNDLE_PATH = (() => {
  const exec = process.execPath;
  const appIndex = exec.indexOf('.app/');
  return appIndex > 0 ? exec.slice(0, appIndex + 4) : exec;
})();

function ownProcessIds(psDump: string): Set<number> {
  const parentOf = new Map<number, number>();
  const ids = new Set<number>([process.pid]);

  try {
    for (const metric of app.getAppMetrics()) ids.add(metric.pid);
  } catch (e) {}

  for (const line of psDump.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    parentOf.set(pid, Number(m[2]));
    if (OWN_BUNDLE_PATH && m[3] && m[3].startsWith(OWN_BUNDLE_PATH)) ids.add(pid);
  }

  for (const pid of parentOf.keys()) {
    let cursor: number | undefined = pid;
    // Bounded so a cycle in the table cannot spin forever.
    for (let hops = 0; cursor && hops < 24; hops++) {
      if (ids.has(cursor)) {
        ids.add(pid);
        break;
      }
      cursor = parentOf.get(cursor);
      if (cursor === 0 || cursor === 1) break;
    }
  }
  return ids;
}

function parseAudioOutPids(assertionDump: string): number[] {
  const lines = assertionDump.split('\n');
  const pids: number[] = [];
  let pendingPid: number | null = null;

  for (const line of lines) {
    const created = line.match(/Created for PID:\s*(\d+)/);
    if (created) {
      pendingPid = Number(created[1]);
      continue;
    }
    // The resource line always follows the PID line for the same assertion.
    if (/\baudio-out\b/.test(line)) {
      if (pendingPid !== null) pids.push(pendingPid);
      pendingPid = null;
    }
  }
  return pids;
}

// The Linux half of the same question. `pactl list sink-inputs` is one entry
// per stream actually attached to an output, with the owning process id in its
// properties - closer to the truth than macOS's power assertions, which stay
// held by a browser that has played anything at all since it started.
// Ownership decided by the process tree, not by a list of our pids.
// `app.getAppMetrics()` does not include Chromium's audio service, and that is
// the process that holds the playback stream - so B.E.N.'s own voice read as
// "another application is playing music" in a silent room. Measured here: two
// sink-inputs named jarvis-live, neither pid in getAppMetrics.
function descendsFromUs(pid: number): boolean {
  let current = pid;
  for (let depth = 0; depth < 12 && current > 1; depth++) {
    if (current === process.pid) return true;
    try {
      const stat = fs.readFileSync(`/proc/${current}/stat`, 'utf8');
      // The command name is in brackets and may contain spaces; ppid is the
      // second field after the closing bracket.
      const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ppid = Number(after[1]);
      if (!Number.isFinite(ppid) || ppid === current) return false;
      current = ppid;
    } catch {
      return false;
    }
  }
  return current === process.pid;
}

function linuxAudioPlaying(): Promise<{ playing: boolean; sources: string[]; error?: string }> {
  return new Promise((resolve) => {
    execFile('pactl', ['list', 'sink-inputs'], { timeout: 2500 }, (err, stdout) => {
      if (err) {
        // No PulseAudio or PipeWire here. Never let a failed probe silently
        // suppress the wake word.
        return resolve({ playing: false, sources: [], error: err.message });
      }
      const ours = (pid: number) => pid === process.pid || descendsFromUs(pid);
      const blocks = stdout.split(/\n(?=Sink Input #)/);
      const sources: string[] = [];
      for (const block of blocks) {
        if (!/Sink Input #/.test(block)) continue;
        // A stream that is corked is paused, not playing.
        if (/Corked:\s*yes/i.test(block)) continue;
        const pidMatch = block.match(/application\.process\.id = "(\d+)"/);
        const pid = pidMatch ? Number(pidMatch[1]) : NaN;
        if (Number.isFinite(pid) && ours(pid)) continue;
        const nameMatch = block.match(/application\.name = "([^"]+)"/);
        sources.push(nameMatch ? nameMatch[1] : String(pid || 'unknown'));
      }
      resolve({ playing: sources.length > 0, sources });
    });
  });
}

ipcMain.handle('is-system-audio-playing', async () => {
  const now = Date.now();
  if (now - systemAudioCache.at < SYSTEM_AUDIO_CACHE_MS) {
    return { playing: systemAudioCache.playing, sources: systemAudioCache.sources };
  }

  if (process.platform === 'linux') {
    const result = await linuxAudioPlaying();
    systemAudioCache = { at: now, playing: result.playing, sources: result.sources };
    return result;
  }

  if (process.platform !== 'darwin') {
    systemAudioCache = { at: now, playing: false, sources: [] };
    return { playing: false, sources: [] };
  }

  return new Promise((resolve) => {
    // One spawn for both halves: the assertions, and the table used to decide
    // which of those PIDs are ours.
    exec(
      'pmset -g assertions; echo "---PSTABLE---"; ps -axo pid=,ppid=,comm=',
      { timeout: 2500, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // Never let a failed probe silently disable the wake word.
          systemAudioCache = { at: now, playing: false, sources: [] };
          return resolve({ playing: false, sources: [], error: err.message });
        }

        const [assertions, psDump = ''] = stdout.split('---PSTABLE---');
        const ours = ownProcessIds(psDump);
        const foreign = parseAudioOutPids(assertions).filter((pid) => !ours.has(pid));
        const sources = foreign.map((pid) => String(pid));

        systemAudioCache = { at: now, playing: foreign.length > 0, sources };
        resolve({ playing: foreign.length > 0, sources });
      }
    );
  });
});

// --- Phone sync ---------------------------------------------------------------
const SYNC_PORT = Number(process.env.BEN_SYNC_PORT) || 8767;
let syncServer: SyncServer | null = null;

function getSyncServer(): SyncServer {
  if (!syncServer) {
    syncServer = new SyncServer({
      memoryPath,
      port: SYNC_PORT,
      // The phone stores the code it was paired with. A code minted per launch
      // means every restart of the desktop silently un-pairs the phone, which
      // shows up as nothing but repeated 401s in the log and a phone that has
      // "stopped working".
      pairingCode: readSyncPref().pairingCode,
      onPairingCode: (code) => writeSyncPref({ pairingCode: code }),
      onLog: (line) => mainWindow?.webContents.send('sync-log', line),
      onMessagesReceived: (messages) =>
        mainWindow?.webContents.send('sync-messages', messages)
    });
  }
  return syncServer;
}

// Remembered across launches: having to switch phone sync on by hand every time
// the app starts is the same as it not working.
const SYNC_PREF = path.join(app.getPath('userData'), 'ben-sync.json');

interface SyncPref {
  enabled?: boolean;
  pairingCode?: string;
}

function readSyncPref(): SyncPref {
  try {
    const parsed = JSON.parse(fs.readFileSync(SYNC_PREF, 'utf8'));
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeSyncPref(patch: SyncPref) {
  try {
    fs.writeFileSync(SYNC_PREF, JSON.stringify({ ...readSyncPref(), ...patch }), 'utf8');
  } catch (e) {}
}

function syncWasOn(): boolean {
  return readSyncPref().enabled === true;
}

function rememberSync(enabled: boolean) {
  writeSyncPref({ enabled });
}

ipcMain.handle('sync-status', async () => getSyncServer().getStatus());
ipcMain.handle('sync-start', async () => {
  rememberSync(true);
  return getSyncServer().start();
});
ipcMain.handle('sync-stop', async () => {
  rememberSync(false);
  return getSyncServer().stop();
});
ipcMain.handle('sync-new-code', async () => {
  getSyncServer().regeneratePairingCode();
  return getSyncServer().getStatus();
});

app.on('before-quit', () => {
  // Stopping here must not clear the preference: this is the app closing, not
  // the user switching the feature off.
  void syncServer?.stop();
  // These now run in their own process group, which means they no longer die
  // with the app on their own.
  signalProcess(activeOpencodeProc, 'SIGTERM');
  signalProcess(activeProjectProc, 'SIGTERM');
});

// Comes back up on its own if it was on when the app last closed.
app.whenReady().then(() => {
  if (!syncWasOn()) return;
  void getSyncServer()
    .start()
    .then((status) => console.log(`[Sync] auto-started on ${status.addresses.join(', ')}:${status.port}`));
});

// --- Background research -----------------------------------------------------
// Answers a question without holding the conversation open while it happens.
// The live model promises to come back with it; this does the work and the
// renderer announces the result when it lands, so "I'll look into it" is a
// commitment the app keeps rather than something the user has to chase.
// A chain, not one name, because model eligibility differs per API key: the same
// request answered fine on one key and came back "no longer available to new
// users" on another, and a spent quota looks different again (429). Tried in
// order; the first that answers is remembered for the rest of the run.
const BACKGROUND_MODELS = (
  process.env.BEN_BACKGROUND_MODEL
    ? [process.env.BEN_BACKGROUND_MODEL]
    : ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest']
);
let lastWorkingBackgroundModel = 0;
const BACKGROUND_TIMEOUT_MS = 90000;
const MAX_BACKGROUND_TASKS = 3;

const activeBackgroundTasks = new Map<string, { question: string; startedAt: number }>();

ipcMain.handle(
  'start-background-task',
  async (
    _event,
    { id, question, apiKey }: { id: string; question: string; apiKey: string }
  ) => {
    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: 'No Gemini API key configured.' };
    }
    if (!question || !question.trim()) {
      return { success: false, error: 'No question supplied.' };
    }
    if (activeBackgroundTasks.size >= MAX_BACKGROUND_TASKS) {
      return {
        success: false,
        error: `Already working on ${activeBackgroundTasks.size} background questions. Wait for one to finish.`
      };
    }

    activeBackgroundTasks.set(id, { question, startedAt: Date.now() });
    console.log(`[Background] started ${id}: ${question.slice(0, 80)}`);

    // Deliberately not awaited: the whole point is that the caller returns now.
    void (async () => {
      const finish = (payload: Record<string, any>) => {
        const task = activeBackgroundTasks.get(id);
        activeBackgroundTasks.delete(id);
        const elapsedMs = task ? Date.now() - task.startedAt : 0;
        console.log(`[Background] finished ${id} in ${elapsedMs}ms (${payload.success ? 'ok' : 'failed'})`);
        mainWindow?.webContents.send('background-task-complete', {
          id,
          question,
          elapsedMs,
          ...payload
        });
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BACKGROUND_TIMEOUT_MS);

      const body = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  `${question}\n\nAnswer in at most two sentences. This will be read ` +
                  'aloud, so no markdown, no lists and no URLs. If you cannot find a ' +
                  'reliable answer, say so plainly.'
              }
            ]
          }
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0 }
      });

      try {
        let lastError = 'no model was reachable';

        for (let attempt = 0; attempt < BACKGROUND_MODELS.length; attempt++) {
          const index = (lastWorkingBackgroundModel + attempt) % BACKGROUND_MODELS.length;
          const model = BACKGROUND_MODELS[index];

          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body
            }
          );

          if (res.ok) {
            const data: any = await res.json();
            const answer = (data?.candidates?.[0]?.content?.parts || [])
              .map((part: any) => part.text)
              .filter(Boolean)
              .join(' ')
              .trim();

            if (!answer) {
              lastError = 'the model returned no answer';
              continue;
            }
            lastWorkingBackgroundModel = index;
            return finish({ success: true, answer, model });
          }

          const detail = await res.text().catch(() => '');
          try {
            const parsed = JSON.parse(detail);
            if (parsed?.error?.message) lastError = parsed.error.message;
            else lastError = `HTTP ${res.status}`;
          } catch (e) {
            lastError = `HTTP ${res.status}`;
          }
          console.warn(`[Background] ${model} refused: ${lastError.slice(0, 120)}`);

          // Only a quota or eligibility refusal is worth trying another model
          // for; anything else will fail the same way on all of them.
          if (res.status !== 429 && res.status !== 404 && !/available|not found|unsupported/i.test(lastError)) {
            break;
          }
        }

        finish({ success: false, error: lastError });
      } catch (err: any) {
        finish({
          success: false,
          error: err?.name === 'AbortError' ? 'Timed out after 90 seconds.' : err?.message || 'Request failed.'
        });
      } finally {
        clearTimeout(timer);
      }
    })();

    return { success: true, started: true, id };
  }
);

// --- Wake word transcription (Groq Whisper) ----------------------------------
// The renderer records the utterance and hands over a WAV; the request is made
// here so the Groq key never rides on a renderer-originated request and there
// is no CORS preflight in the way.
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = process.env.BEN_GROQ_MODEL || 'whisper-large-v3-turbo';
// Named in case the tuned turbo model is not on the account's plan.
const GROQ_MODEL_FALLBACK = 'whisper-large-v3';

async function groqTranscribe(
  apiKey: string,
  wav: Buffer,
  model: string,
  prompt: string
): Promise<{
  ok: boolean;
  text?: string;
  error?: string;
  status?: number;
  avgLogprob?: number | null;
  noSpeechProb?: number | null;
}> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', model);
  // verbose_json carries per-segment avg_logprob, which is what separates a real
  // transcript from an invented one. A plain json response gives text only, and
  // text alone never looks uncertain.
  form.append('response_format', 'verbose_json');
  form.append('language', 'en');
  // Whisper leans on the prompt for proper nouns. Without it "Ben" comes back
  // as "been", "Ken" or "Bem" often enough to miss the wake word.
  form.append('prompt', prompt);
  form.append('temperature', '0');

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Groq answers with a JSON error envelope. Surfacing the raw body puts a
    // wall of escaped JSON in the UI, so unwrap the message when it is there.
    let message = detail.slice(0, 300) || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch (e) {}
    return { ok: false, status: res.status, error: message };
  }

  const data: any = await res.json();
  const segments: any[] = Array.isArray(data?.segments) ? data.segments : [];
  const avgLogprob = segments.length
    ? segments.reduce((sum, seg) => sum + (seg.avg_logprob ?? 0), 0) / segments.length
    : null;
  const noSpeechProb = segments.length
    ? Math.max(...segments.map((seg) => seg.no_speech_prob ?? 0))
    : null;

  return {
    ok: true,
    text: (data?.text || '').trim(),
    avgLogprob,
    // Reported for auditing only. Some distilled checkpoints return near-zero
    // for this on pure silence, so nothing is decided on it.
    noSpeechProb
  };
}

ipcMain.handle(
  'groq-transcribe',
  async (
    _event,
    { apiKey, wavBase64, prompt }: { apiKey: string; wavBase64: string; prompt?: string }
  ) => {
    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: 'No Groq API key configured.' };
    }
    if (!wavBase64) {
      return { success: false, error: 'No audio supplied.' };
    }

    const wav = Buffer.from(wavBase64, 'base64');
    // Deliberately just the name. The previous hint was "Hey Ben. Ben, are you
    // there? Ben, wake up." - which is the wake phrase itself, so every silence
    // Whisper decided to fill was filled with a phrase that would wake him.
    const hint = prompt || 'B.E.N.';

    try {
      let res = await groqTranscribe(apiKey.trim(), wav, GROQ_MODEL, hint);

      // A model the account cannot reach is a configuration problem, not a
      // transcription failure: try the widely available one before giving up.
      if (!res.ok && (res.status === 404 || /model/i.test(res.error || ''))) {
        console.warn(`[Groq] ${GROQ_MODEL} unavailable, retrying with ${GROQ_MODEL_FALLBACK}`);
        res = await groqTranscribe(apiKey.trim(), wav, GROQ_MODEL_FALLBACK, hint);
      }

      if (!res.ok) {
        // A rejected key or a blocked account will not fix itself on the next
        // utterance, so say so and let the renderer stop asking.
        const fatal = res.status === 401 || res.status === 403;
        return { success: false, error: res.error, status: res.status, fatal };
      }
      return {
        success: true,
        text: res.text,
        avgLogprob: res.avgLogprob,
        noSpeechProb: res.noSpeechProb
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Transcription request failed.' };
    }
  }
);

const OPENCODE_MODEL = process.env.BEN_OPENCODE_MODEL || 'opencode/nemotron-3.5-lightning-free';
const EXTRA_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${path.join(os.homedir(), '.opencode', 'bin')}`;

// A process the user just cancelled must not come straight back. The model
// often still has the original "run it" instruction in context and will call
// the tool again the moment it is told the process stopped.
const RESTART_COOLDOWN_MS = 90000;
let lastCancel: { project: string | null; at: number } = { project: null, at: 0 };

// Every file operation is confined to the workspace. Returns null for anything
// that escapes it, including via symlink or "..".
function resolveInWorkspace(relativePath: string): string | null {
  const cleaned = (relativePath || '').trim().replace(/^[~/]+/, '');
  const target = path.resolve(DEFAULT_DEV_DIR, cleaned);
  const root = path.resolve(DEFAULT_DEV_DIR);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

// Folder names are matched case-insensitively so "ben" finds "BEN".
function resolveProjectDir(projectName: string): string | null {
  const name = (projectName || '').trim();
  if (!name) return null;
  const direct = resolveInWorkspace(name);
  if (direct && fs.existsSync(direct)) return direct;
  try {
    const match = fs
      .readdirSync(DEFAULT_DEV_DIR, { withFileTypes: true })
      .find((e) => e.isDirectory() && e.name.toLowerCase() === name.toLowerCase());
    return match ? path.join(DEFAULT_DEV_DIR, match.name) : null;
  } catch (e) {
    return null;
  }
}
const LOCAL_OPENCODE_BIN = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
const OPENCODE_BIN = fs.existsSync(LOCAL_OPENCODE_BIN) ? LOCAL_OPENCODE_BIN : 'opencode';

let activeOpencodeProc: any = null;
let activeOpencodeProject: string | null = null;
// Set by cancel-opencode so the completion broadcast can say the build was
// stopped on purpose rather than reporting a failure.
let opencodeCancelRequested = false;

ipcMain.handle('run-opencode', async (_event, { prompt, projectName }: { prompt: string; projectName?: string }) => {
  if (activeOpencodeProc) {
    return {
      success: false,
      alreadyRunning: true,
      error: `An autonomous build is already currently running for project '${activeOpencodeProject || 'workspace'}'. Please wait until it completes.`,
      directory: DEFAULT_DEV_DIR
    };
  }

  const subfolder = projectName || 'project-' + Date.now().toString(36);
  const targetDir = path.join(DEFAULT_DEV_DIR, subfolder);
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {}
  }

  const args = [
    'run',
    '--dir', targetDir,
    '--auto',
    '-m', OPENCODE_MODEL,
    prompt
  ];

  console.log(`[Opencode] Spawning in ${targetDir}: ${OPENCODE_BIN} ${args.join(' ')}`);
  mainWindow?.webContents.send('opencode-log', `⚡ Starting Autonomous Build in ${targetDir}...\n> Prompt: ${prompt}\n\n`);

  let proc: any;
  try {
    proc = spawn(OPENCODE_BIN, args, {
      cwd: targetDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group. opencode spawns compilers, package managers and
      // language servers of its own, and signalling only the parent left all of
      // them running: the build carried on writing files while B.E.N. reported
      // it stopped. Killing the group is the only way to stop the work rather
      // than the process that started it.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:${EXTRA_PATH}`
      }
    });
  } catch (err: any) {
    mainWindow?.webContents.send('opencode-log', `\n❌ [Process Error: ${err.message}]\n`);
    return { success: false, error: err.message, directory: targetDir, projectName: subfolder };
  }

  opencodeCancelRequested = false;
  activeOpencodeProject = subfolder;
  activeOpencodeProc = proc;

  let fullLog = '';
  let settled = false;

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString();
    fullLog += text;
    mainWindow?.webContents.send('opencode-log', text);
  };

  proc.stdout.on('data', handleChunk);
  proc.stderr.on('data', handleChunk);

  // A build takes minutes. The renderer is told it started straight away and
  // hears about the outcome on 'opencode-complete'; awaiting the whole build
  // inside the IPC call froze the live voice session for its entire duration.
  const finish = (payload: Record<string, any>) => {
    if (settled) return;
    settled = true;
    activeOpencodeProc = null;
    activeOpencodeProject = null;
    const cancelled = opencodeCancelRequested;
    opencodeCancelRequested = false;
    mainWindow?.webContents.send('opencode-complete', {
      projectName: subfolder,
      directory: targetDir,
      cancelled,
      output: fullLog.slice(-3000),
      ...payload
    });
  };

  proc.on('close', (code: number | null) => {
    console.log(`[Opencode] Finished with exit code: ${code}`);
    mainWindow?.webContents.send('opencode-log', `\n🏁 [Build Complete - Exit Code ${code}]\n`);
    finish(
      code === 0
        ? { success: true, exitCode: code }
        : { success: false, exitCode: code, error: `Opencode process returned code ${code}` }
    );
  });

  proc.on('error', (err: any) => {
    console.error('[Opencode] Spawn error:', err);
    mainWindow?.webContents.send('opencode-log', `\n❌ [Process Error: ${err.message}]\n`);
    finish({ success: false, error: err.message });
  });

  return { success: true, started: true, directory: targetDir, projectName: subfolder };
});

let activeProjectProc: any = null;
let activeProjectName: string | null = null;

// A dev server announces itself by printing its address. Only loopback counts:
// this address is opened in the user's browser without asking, and a URL a
// process printed is not consent to visit an address on the internet.
const LOCAL_URL = /(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d{2,5})?(\/[^\s"'`\]]*)?/i;
const ANSI_CODES = /\x1b\[[0-9;]*m/g;

function findLocalUrl(text: string): string | null {
  // Vite and friends print the address inside ANSI colour codes.
  const match = text.replace(ANSI_CODES, '').match(LOCAL_URL);
  if (!match) return null;
  // The wildcard forms - 0.0.0.0, [::], [::1] - say where the server listens,
  // which is not an address a browser can be sent to. Python's http.server
  // announces itself as http://[::]:8000/ and nothing else would open it.
  const host = /^(localhost|127\.0\.0\.1)$/i.test(match[2]) ? match[2] : 'localhost';
  const tail = (match[4] || '').replace(/[.,)]+$/, '');
  return `${match[1]}${host}${match[3] || ''}${tail}`;
}

// A program waiting on input has written its question without a newline after
// it, so the last thing in the buffer is a bare prompt. This is a hint for the
// console, never a gate on the input box: being wrong here must not stop the
// user typing.
function looksLikePrompt(text: string): boolean {
  if (/\n\s*$/.test(text)) return false;
  const tail = text.replace(ANSI_CODES, '').trimEnd();
  if (!tail) return false;
  return /[:?>]$/.test(tail) || /\b(enter|type|input|choose|select|press|y\/n)\b/i.test(tail.slice(-60));
}

// What the user types in the console goes to the running process. Without this
// a program that asks a question just sits there: stdin is a pipe with nothing
// on the other end of it.
ipcMain.handle('send-process-input', async (_event, { text }: { text: string }) => {
  const proc = activeProjectProc;
  if (!proc || !proc.stdin || proc.stdin.destroyed) {
    return { success: false, error: 'Nothing is running that can be typed into.' };
  }
  const line = typeof text === 'string' ? text : '';
  try {
    proc.stdin.write(line + '\n');
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  // Echoed back so the console reads like a terminal: the process does not see
  // its own stdin, so without this the answer never appears next to the question.
  mainWindow?.webContents.send('opencode-log', `${line}\n`);
  return { success: true, projectName: activeProjectName };
});

// Is this pid still there? `kill(pid, 0)` sends no signal and throws ESRCH when
// nothing is left - the only way to know a stop worked rather than assuming it.
function processAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Signal the whole group where there is one, falling back to the process alone.
function signalProcess(proc: any, signal: NodeJS.Signals): boolean {
  if (!proc || !proc.pid) return false;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-proc.pid, signal);
        return true;
      } catch {
        // No group (Windows, or already reaped): fall through.
      }
    }
    proc.kill(signal);
    return true;
  } catch {
    return false;
  }
}

// SIGTERM, then check, then SIGKILL. A build that ignores the polite signal
// used to be reported as stopped anyway.
async function stopProcess(proc: any): Promise<boolean> {
  if (!proc || !proc.pid) return false;
  const pid = proc.pid;
  signalProcess(proc, 'SIGTERM');
  for (let waited = 0; waited < 3000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    if (!processAlive(pid)) return true;
  }
  signalProcess(proc, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  return !processAlive(pid);
}

ipcMain.handle('cancel-opencode', async () => {
  // Captured before the handles are cleared, or the cooldown records no project.
  const cancelledProject = activeOpencodeProject;
  const hadBuild = !!activeOpencodeProc;
  const hadProcess = !!activeProjectProc;

  let buildStopped = false;
  if (activeOpencodeProc) {
    opencodeCancelRequested = true;
    // The 'close' handler still fires and broadcasts 'opencode-complete',
    // which is what releases the renderer-side build lock.
    buildStopped = await stopProcess(activeOpencodeProc);
  }

  let processStopped = false;
  if (activeProjectProc) {
    processStopped = await stopProcess(activeProjectProc);
    activeProjectProc = null;
    activeProjectName = null;
  }

  const wasRunning = hadBuild || hadProcess;
  // Read back rather than assume: a signal sent is not a process gone, and
  // "everything has been stopped" was said before anything was checked.
  const stillRunning = (hadBuild && !buildStopped) || (hadProcess && !processStopped);

  if (wasRunning) lastCancel = { project: cancelledProject, at: Date.now() };
  mainWindow?.webContents.send(
    'opencode-log',
    wasRunning
      ? stillRunning
        ? '\n⚠️ [Stop requested - the process did not exit]\n'
        : '\n🛑 [Process Terminated by User]\n'
      : '\n… [Stop requested - nothing was running]\n'
  );

  return {
    success: !stillRunning,
    wasRunning,
    stopped: wasRunning && !stillRunning,
    stillRunning,
    project: cancelledProject || null,
    stoppedBuild: hadBuild && buildStopped,
    stoppedProcess: hadProcess && processStopped
  };
});

// What is actually running, asked of the process table rather than of anything
// the model remembers saying. Nothing in the app could answer "is the build
// finished?", so it was answered from the conversation - which is how a running
// build got reported as complete.
ipcMain.handle('opencode-status', async () => {
  const buildPid = activeOpencodeProc?.pid;
  const projectPid = activeProjectProc?.pid;
  return {
    build: activeOpencodeProc
      ? { project: activeOpencodeProject, pid: buildPid, alive: processAlive(buildPid) }
      : null,
    process: activeProjectProc
      ? { project: activeProjectName, pid: projectPid, alive: processAlive(projectPid) }
      : null,
    lastCancelledProject: lastCancel.project || null,
    lastCancelAgoMs: lastCancel.at ? Date.now() - lastCancel.at : null
  };
});

// Run commands inside project directory (e.g. npm run dev, npm install, etc.)
ipcMain.handle(
  'run-project-command',
  async (_event, { projectName, command, force }: { projectName: string; command?: string; force?: boolean }) => {
  try {
    const targetDir = resolveProjectDir(projectName);
    if (!targetDir) {
      return {
        success: false,
        error: `No project folder named '${projectName}' exists in ${DEFAULT_DEV_DIR}.`
      };
    }

    // Refuse to silently restart something the user just stopped.
    const sinceCancel = Date.now() - lastCancel.at;
    if (!force && lastCancel.at && sinceCancel < RESTART_COOLDOWN_MS) {
      return {
        success: false,
        cancelledRecently: true,
        error:
          'The user cancelled a process moments ago. Do not restart it. Tell the user it is stopped ' +
          'and wait for them to explicitly ask for it to be run again.'
      };
    }

    // Kill any existing running server process
    if (activeProjectProc) {
      try {
        activeProjectProc.kill('SIGTERM');
      } catch (e) {}
      activeProjectProc = null;
      activeProjectName = null;
    }

    let cmdToRun = (command || '').trim();

    // Auto-detect startup script if generic 'run' or 'start' requested
    if (!cmdToRun || cmdToRun === 'run' || cmdToRun === 'start' || cmdToRun === 'dev') {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts?.dev) {
            cmdToRun = 'npm run dev';
          } else if (pkg.scripts?.start) {
            cmdToRun = 'npm start';
          } else {
            cmdToRun = 'npm run build';
          }
        } catch (e) {
          cmdToRun = 'npm run dev';
        }
      } else if (fs.existsSync(path.join(targetDir, 'main.py'))) {
        // -u, always. Python block-buffers stdout when it is a pipe rather than
        // a terminal, so `print('Name: ', end='')` before an input() sits in the
        // buffer and the console shows nothing - the program looks hung when it
        // is in fact waiting for the user to type.
        cmdToRun = 'python3 -u main.py';
      } else if (fs.existsSync(path.join(targetDir, 'app.py'))) {
        cmdToRun = 'python3 -u app.py';
      } else if (fs.existsSync(path.join(targetDir, 'index.html'))) {
        cmdToRun = 'npx -y serve .';
      } else {
        cmdToRun = 'ls -la';
      }
    }

    console.log(`[Project Runner] Running in ${targetDir}: ${cmdToRun}`);
    mainWindow?.webContents.send('opencode-log', `🚀 [Starting Process in ${targetDir}]: ${cmdToRun}\n\n`);

    // Run command asynchronously with child_process.
    // stdin is a pipe rather than inherited: a program that asks a question
    // needs somewhere for the answer to come from, and the console in the deck
    // is that somewhere. PYTHONUNBUFFERED covers the interpreter we did not
    // choose the command line for.
    const child = spawn(cmdToRun, {
      cwd: targetDir,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // `shell: true` means the child is a shell and the dev server is *its*
      // child. Signalling the shell left the server holding the port, which is
      // the same "I stopped it" that was not true.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PATH: `${process.env.PATH}:${EXTRA_PATH}`
      }
    });

    activeProjectProc = child;
    activeProjectName = projectName;

    let stdoutData = '';
    let stderrData = '';
    let servedUrl: string | null = null;

    const noteUrl = (text: string) => {
      if (servedUrl) return;
      const found = findLocalUrl(text);
      if (!found) return;
      servedUrl = found;
      mainWindow?.webContents.send('project-url', { projectName, url: found });
      // The user asked for this to be run; a dev server's own address is the
      // thing they asked to see. Only loopback is opened automatically - a URL
      // printed by a process is not a reason to visit an address on the
      // internet without being asked.
      shell.openExternal(found).catch(() => {});
      mainWindow?.webContents.send('opencode-log', `\n🌐 [Opening ${found}]\n`);
    };

    const onOutput = (txt: string) => {
      mainWindow?.webContents.send('opencode-log', `[${projectName}] ${txt}`);
      noteUrl(txt);
      // A question written without a trailing newline is a program waiting for
      // an answer. The console uses this to point the user at the input box
      // instead of leaving them watching a cursor.
      if (looksLikePrompt(txt)) {
        mainWindow?.webContents.send('project-awaiting-input', {
          projectName,
          prompt: txt.slice(-200)
        });
      }
    };

    child.stdout.on('data', (d) => {
      const txt = d.toString();
      stdoutData += txt;
      onOutput(txt);
    });

    child.stderr.on('data', (d) => {
      const txt = d.toString();
      stderrData += txt;
      onOutput(txt);
    });

    child.on('close', (code) => {
      activeProjectProc = null;
      activeProjectName = null;
      mainWindow?.webContents.send('opencode-log', `\n🏁 [Process Exited with Code ${code}]\n`);
    });

    // Long enough for a dev server to print its address, short enough that the
    // voice session is not left waiting: Vite prints in 300-900 ms here. A
    // command that produces output and exits is not waited on at all.
    const deadline = Date.now() + 2600;
    while (Date.now() < deadline && !servedUrl && activeProjectProc === child) {
      await new Promise((r) => setTimeout(r, 120));
      if (!servedUrl && (stdoutData || stderrData) && child.exitCode !== null) break;
    }

    return {
      success: true,
      directory: targetDir,
      commandExecuted: cmdToRun,
      url: servedUrl,
      // Whether the process is still up decides what B.E.N. should say: a dev
      // server is running, a script that has already exited is finished.
      stillRunning: child.exitCode === null && !child.killed,
      acceptsInput: !!child.stdin && !child.stdin.destroyed,
      preview: (stdoutData || stderrData || `Launched command '${cmdToRun}' in background.`).slice(0, 500)
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  }
);

// --- Skill library -----------------------------------------------------------

// Two roots: the skills that ship with B.E.N., and the third-party collections
// the user installs.
const SKILLS_DIR = path.join(app.getPath('userData'), 'skills');
const BUNDLED_SKILLS_DIR = [
  path.join(__dirname, '..', 'skills'),
  path.join(app.getAppPath(), 'skills'),
  path.join(process.resourcesPath || '', 'skills')
].find((candidate) => candidate && fs.existsSync(candidate));

function collectSkills() {
  const bundled = BUNDLED_SKILLS_DIR ? listSkills(BUNDLED_SKILLS_DIR, 'ben') : [];
  // B.E.N.'s own skills come first so they win a name collision.
  return [...bundled, ...listSkills(SKILLS_DIR)];
}

ipcMain.handle('list-skills', async () => {
  return { directory: SKILLS_DIR, bundledDirectory: BUNDLED_SKILLS_DIR || null, skills: collectSkills() };
});

ipcMain.handle('read-skill', async (_event, { id }: { id: string }) => {
  return readSkillFrom(collectSkills(), id);
});

ipcMain.handle('sync-skills', async (_event, { sources }: { sources?: string[] } = {}) => {
  const list = sources?.length ? sources : DEFAULT_SKILL_SOURCES;
  const results = await syncSkills(SKILLS_DIR, list, (line) =>
    mainWindow?.webContents.send('skills-log', line)
  );
  return { results, skills: collectSkills() };
});

// --- Workspace file operations ----------------------------------------------
// Everything here is confined to the workspace directory by resolveInWorkspace.

ipcMain.handle('write-workspace-file', async (_event, { relativePath, content, append }) => {
  const target = resolveInWorkspace(relativePath);
  if (!target) return { success: false, error: 'Path is outside the workspace directory.' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (append && fs.existsSync(target)) {
      fs.appendFileSync(target, content ?? '', 'utf8');
    } else {
      fs.writeFileSync(target, content ?? '', 'utf8');
    }
    return {
      success: true,
      path: target,
      displayPath: target.replace(os.homedir(), '~'),
      bytes: Buffer.byteLength(content ?? '', 'utf8')
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('read-workspace-file', async (_event, { relativePath }) => {
  const target = resolveInWorkspace(relativePath);
  if (!target) return { success: false, error: 'Path is outside the workspace directory.' };
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { success: false, error: `No file at ${target}` };
    }
    // Capped: this text goes back through the model.
    const content = fs.readFileSync(target, 'utf8').slice(0, 20000);
    return { success: true, path: target, content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('list-workspace-folder', async (_event, { relativePath }) => {
  const target = resolveInWorkspace(relativePath || '');
  if (!target) return { success: false, error: 'Path is outside the workspace directory.' };
  try {
    if (!fs.existsSync(target)) return { success: false, error: `No folder at ${target}` };
    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .slice(0, 200)
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'folder' : 'file' }));
    return { success: true, path: target, displayPath: target.replace(os.homedir(), '~'), entries };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('create-workspace-folder', async (_event, { relativePath }) => {
  const target = resolveInWorkspace(relativePath);
  if (!target) return { success: false, error: 'Path is outside the workspace directory.' };
  try {
    fs.mkdirSync(target, { recursive: true });
    return { success: true, path: target, displayPath: target.replace(os.homedir(), '~') };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Where a given file should open. Prose goes to a notes app, source goes to the
// editor, and anything unrecognised is left to the system default.
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.zsh', '.bash', '.sql', '.json', '.yaml',
  '.yml', '.toml', '.ini', '.env', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue',
  '.svelte', '.xml', '.gradle', '.lock', '.ipynb', '.r', '.lua', '.pl', '.dart', '.ex', '.exs'
]);
const CODE_FILENAMES = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'justfile']);
const DOCUMENT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.text', '.rtf', '.rtfd', '.pdf', '.doc', '.docx', '.pages'
]);

type OpenKind = 'editor' | 'notes' | 'finder' | 'default';

function classifyPath(target: string): OpenKind {
  try {
    if (fs.statSync(target).isDirectory()) return 'editor';
  } catch {
    return 'default';
  }
  const base = path.basename(target).toLowerCase();
  const ext = path.extname(base);
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'notes';
  if (CODE_EXTENSIONS.has(ext) || CODE_FILENAMES.has(base)) return 'editor';
  return 'default';
}

// Which application opens code here is a fact about this machine, not a
// constant. Visual Studio Code was hardcoded, so on a Mac without it "open
// this in Antigravity" reported Visual Studio Code for a window the system
// default had opened - a claim about an app the user was not looking at.
const APP_SEARCH_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  path.join(os.homedir(), 'Applications'),
  '/System/Applications',
  '/System/Applications/Utilities'
];

// An application is a bundle in /Applications on one machine and a .desktop
// entry on another, and this app had only ever been run on the first kind. On
// Linux `installedApps()` returned an empty list, so there was no editor to
// open anything with, no application could be resolved by name, and `open-app`
// fell through to a Windows branch that ran `cmd /c start`. B.E.N. did not
// think it was on a Mac - the code did.
const LINUX_APP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  path.join(os.homedir(), '.local/share/applications'),
  '/var/lib/snapd/desktop/applications',
  '/var/lib/flatpak/exports/share/applications',
  path.join(os.homedir(), '.local/share/flatpak/exports/share/applications')
];

interface DesktopEntry {
  name: string;
  exec: string;
  file: string;
}

let linuxEntriesCache: { entries: DesktopEntry[]; at: number } | null = null;

// Only the [Desktop Entry] group, only Type=Application, and NoDisplay entries
// are skipped: they are URL handlers and helpers, not things a person opens.
function parseDesktopEntry(file: string): DesktopEntry | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const group = text.split(/^\[/m)[0].includes('Desktop Entry')
      ? text
      : '[' + (text.split(/^\[/m).find((part) => part.startsWith('Desktop Entry')) || '');
    const value = (key: string) => {
      const match = group.match(new RegExp(`^${key}=(.*)$`, 'm'));
      return match ? match[1].trim() : '';
    };
    if (value('Type') && value('Type') !== 'Application') return null;
    if (/^true$/i.test(value('NoDisplay')) || /^true$/i.test(value('Hidden'))) return null;
    const name = value('Name');
    const exec = value('Exec');
    if (!name || !exec) return null;
    return { name, exec, file };
  } catch {
    return null;
  }
}

function linuxDesktopEntries(): DesktopEntry[] {
  if (linuxEntriesCache && Date.now() - linuxEntriesCache.at < APP_CACHE_MS) {
    return linuxEntriesCache.entries;
  }
  const entries: DesktopEntry[] = [];
  const seen = new Set<string>();
  for (const dir of LINUX_APP_DIRS) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.desktop')) continue;
        const entry = parseDesktopEntry(path.join(dir, file));
        if (!entry) continue;
        const key = entry.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    } catch {
      // A directory that does not exist on this machine is not an error.
    }
  }
  linuxEntriesCache = { entries, at: Date.now() };
  return entries;
}

// Exec= carries field codes (%U, %f, %i) that are placeholders for the caller's
// arguments, not arguments themselves. Passing them through launches the app
// with a literal "%U" as its file to open.
function execCommand(entry: DesktopEntry): { bin: string; args: string[] } | null {
  const parts = entry.exec
    .replace(/%[A-Za-z]/g, '')
    .trim()
    .match(/"[^"]+"|\S+/g);
  if (!parts || !parts.length) return null;
  const clean = parts.map((part) => part.replace(/^"|"$/g, ''));
  // env VAR=x /usr/bin/thing is common in snap and flatpak entries.
  while (clean.length > 1 && (clean[0] === 'env' || clean[0].includes('='))) clean.shift();
  return { bin: clean[0], args: clean.slice(1) };
}

function linuxEntryFor(appName: string): DesktopEntry | null {
  const want = appName.trim().toLowerCase();
  if (!want) return null;
  const entries = linuxDesktopEntries();
  return (
    entries.find((e) => e.name.toLowerCase() === want) ||
    entries.find((e) => e.name.toLowerCase().startsWith(want)) ||
    entries.find((e) => e.name.toLowerCase().includes(want)) ||
    null
  );
}

// Preference order, consulted only when the user names no application. An
// editor missing from this list is still reachable by name.
// Order matters twice over: it picks the default editor, and it settles a
// spoken name that matches more than one installed app. "Antigravity" is both
// com.google.antigravity and com.google.antigravity-ide on this machine, and
// the IDE is the one that opens a folder.
const KNOWN_EDITORS = [
  'Antigravity IDE', 'Visual Studio Code', 'Code - OSS', 'VSCodium', 'Cursor', 'Antigravity',
  'Windsurf', 'Zed', 'Sublime Text', 'WebStorm', 'IntelliJ IDEA', 'PyCharm',
  'Android Studio', 'Nova', 'BBEdit', 'Xcode',
  // Names as Linux desktop entries spell them.
  'Neovim', 'Kate', 'GNU Emacs', 'Gedit', 'Text Editor', 'Geany'
];

// Applications come and go rarely; a directory read per open would be wasteful,
// and a cache that never expires misses an editor installed while the app runs.
let installedAppsCache: { names: string[]; at: number } | null = null;
const APP_CACHE_MS = 60_000;

function installedApps(): string[] {
  if (installedAppsCache && Date.now() - installedAppsCache.at < APP_CACHE_MS) {
    return installedAppsCache.names;
  }
  if (process.platform === 'linux') {
    const names = linuxDesktopEntries().map((entry) => entry.name);
    installedAppsCache = { names, at: Date.now() };
    return names;
  }
  const names: string[] = [];
  for (const dir of APP_SEARCH_DIRS) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.app')) {
          const name = entry.slice(0, -4);
          if (!names.includes(name)) names.push(name);
        }
      }
    } catch {
      // A search directory that does not exist on this machine is not an error.
    }
  }
  installedAppsCache = { names, at: Date.now() };
  return names;
}

// Resolve a spoken application name against what is actually installed. Returns
// null rather than guessing: being told Antigravity is not here beats having
// something else opened and called Antigravity.
function resolveInstalledApp(requested: string, preferEditor = false): string | null {
  const want = requested.trim().toLowerCase().replace(/\.app$/, '');
  if (!want) return null;
  const apps = installedApps();

  // An exact name is taken at its word when launching an application. When
  // opening code it is not: "Antigravity" names two installed apps here and
  // only one of them is the IDE, so the editor order below decides.
  const exact = apps.find((a) => a.toLowerCase() === want);
  if (exact && !preferEditor) return exact;

  // "antigravity" matches both "Antigravity" and "Antigravity IDE". A known
  // editor wins, in the order above; otherwise the shortest name is the one
  // most likely to be what was said ("Chrome", not "Chrome Canary").
  const rank = (name: string) => {
    const idx = KNOWN_EDITORS.findIndex((e) => e.toLowerCase() === name.toLowerCase());
    return idx === -1 ? KNOWN_EDITORS.length : idx;
  };
  const preferred = (a: string, b: string) => rank(a) - rank(b) || a.length - b.length;

  const prefixed = apps.filter((a) => a.toLowerCase().startsWith(want)).sort(preferred);
  if (prefixed.length) return prefixed[0];

  const contained = apps.filter((a) => a.toLowerCase().includes(want)).sort(preferred);
  if (contained.length) return contained[0];

  return null;
}

// Editors installed here, in preference order. Offered back when a requested
// one is missing, so B.E.N. can say what there is instead of guessing again.
function installedEditors(): string[] {
  const apps = installedApps();
  return KNOWN_EDITORS.filter((name) =>
    apps.some((a) => a.toLowerCase() === name.toLowerCase())
  );
}

// The editor to use when the user names none: an explicit override, else the
// first known editor that is really installed, else nothing - and "nothing" is
// reported as such rather than dressed up as an editor.
function defaultEditorApp(): string | null {
  const override = (process.env.BEN_EDITOR_APP || '').trim();
  if (override) return resolveInstalledApp(override) || override;
  return installedEditors()[0] || null;
}

// `open -a` exiting cleanly is the launch request being accepted, not the app
// being open. Read the fact back, the same way open-app does.
async function openInApp(appName: string, target: string): Promise<boolean> {
  const launched = await launchApp(appName, target);
  if (!launched.ok) return false;
  await new Promise((r) => setTimeout(r, 900));
  return (await appRunningState(appName)) !== 'no';
}

ipcMain.handle('get-editor-info', async () => ({
  editor: defaultEditorApp(),
  editors: installedEditors()
}));

// Opens the actual file or folder, rather than just launching an application.
ipcMain.handle('open-workspace-path', async (_event, { relativePath, mode, app: requestedApp }) => {
  const target = resolveInWorkspace(relativePath || '');
  if (!target) return { success: false, error: 'Path is outside the workspace directory.' };
  if (!fs.existsSync(target)) return { success: false, error: `Nothing exists at ${target}` };

  const displayPath = target.replace(os.homedir(), '~');
  const wanted = typeof requestedApp === 'string' ? requestedApp.trim() : '';
  // Naming an application is naming the editor branch: "open it in Antigravity"
  // is not a request to route by file type.
  const kind: OpenKind =
    wanted ? 'editor' : !mode || mode === 'auto' ? classifyPath(target) : (mode as OpenKind);

  if (kind === 'finder') {
    shell.showItemInFolder(target);
    // The name of the thing the user is now looking at, which differs per
    // platform and is read out loud.
    const browser =
      process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'File Explorer' : 'the file manager';
    return { success: true, openedIn: browser, kind, path: target, displayPath };
  }

  if (kind === 'notes') {
    // Notes is a macOS application. Elsewhere there is no equivalent worth
    // assuming, so unless one is named the system default opens the document.
    const notesApp =
      process.env.BEN_NOTES_APP || (process.platform === 'darwin' ? 'Notes' : '');
    if (notesApp && (await openInApp(notesApp, target))) {
      return { success: true, openedIn: notesApp, kind, path: target, displayPath };
    }
    // Notes refused the type; let the system decide rather than failing.
    const fallback = await shell.openPath(target);
    if (fallback) return { success: false, error: fallback };
    return { success: true, openedIn: 'default application', kind, path: target, displayPath };
  }

  if (kind === 'editor') {
    // An application the user named wins over everything else. If it is not
    // here, say so and name what is - opening something else and reporting the
    // name they asked for is the bug this replaced.
    if (wanted) {
      const resolved = resolveInstalledApp(wanted, true);
      if (!resolved) {
        return {
          success: false,
          kind,
          requestedApp: wanted,
          availableEditors: installedEditors(),
          error:
            `${wanted} is not installed on this machine, so nothing was opened. Tell the user ` +
            'that and offer what is available instead. Do not say it opened.'
        };
      }
      if (await openInApp(resolved, target)) {
        return { success: true, openedIn: resolved, kind, path: target, displayPath };
      }
      return {
        success: false,
        kind,
        requestedApp: wanted,
        error: `${resolved} did not open ${displayPath}. Tell the user it did not open.`
      };
    }

    const editor = defaultEditorApp();
    if (editor) {
      // VS Code's CLI opens the folder in the window already on screen; every
      // other editor is launched by bundle name.
      if (editor === 'Visual Studio Code') {
        const viaCode = await new Promise<boolean>((resolve) => {
          execFile(
            'code',
            [target],
            { env: { ...process.env, PATH: `${process.env.PATH}:${EXTRA_PATH}` } },
            (err) => resolve(!err)
          );
        });
        if (viaCode) return { success: true, openedIn: editor, kind, path: target, displayPath };
      }
      if (await openInApp(editor, target)) {
        return { success: true, openedIn: editor, kind, path: target, displayPath };
      }
    }

    const fallback = await shell.openPath(target);
    if (fallback) return { success: false, error: fallback, kind };
    return {
      success: true,
      // Never an editor's name: this is whatever the system decided to use, and
      // the model announces this field out loud.
      openedIn: 'the default application',
      kind,
      path: target,
      displayPath,
      availableEditors: installedEditors(),
      note: editor
        ? `${editor} would not open it, so the system default did. Say that.`
        : 'No code editor is installed here, so the system default opened it. Say that, and do not name an editor.'
    };
  }

  const err = await shell.openPath(target);
  if (err) return { success: false, error: err };
  return { success: true, openedIn: 'default application', kind, path: target, displayPath };
});

// List Projects in the workspace
// Resolved once: a PATH lookup per poll would be wasteful and the answer
// does not change while the app is running.
let opencodeAvailable: boolean | null = null;

function resolveOpencodeAvailable(): Promise<boolean> {
  if (opencodeAvailable !== null) return Promise.resolve(opencodeAvailable);
  if (OPENCODE_BIN !== 'opencode') {
    opencodeAvailable = true;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    exec('command -v opencode', { shell: '/bin/zsh' }, (err, stdout) => {
      opencodeAvailable = !err && !!stdout.trim();
      resolve(opencodeAvailable);
    });
  });
}

ipcMain.handle('get-workspace-info', async () => {
  return {
    directory: DEFAULT_DEV_DIR,
    displayPath: DEFAULT_DEV_DIR.replace(os.homedir(), '~'),
    exists: fs.existsSync(DEFAULT_DEV_DIR),
    opencodeBin: OPENCODE_BIN,
    opencodeAvailable: await resolveOpencodeAvailable(),
    model: OPENCODE_MODEL,
    busy: !!activeOpencodeProc || !!activeProjectProc,
    activeProject: activeOpencodeProject
  };
});

ipcMain.handle('list-development-projects', async () => {
  try {
    if (!fs.existsSync(DEFAULT_DEV_DIR)) return [];
    const entries = fs.readdirSync(DEFAULT_DEV_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch (err: any) {
    return [];
  }
});

// Persistent Memory Store
const memoryPath = path.join(app.getPath('userData'), 'ben-memory.json');

// The tool journal, in its own file.
//
// Deliberately not part of ben-memory.json: memory is written whole by the
// renderer and merged here on every save, and a record appended to on every
// tool call has no business riding that path. Losing a journal entry costs a
// lesson; losing a message costs the conversation.
const journalPath = path.join(app.getPath('userData'), 'ben-journal.json');
const MAX_JOURNAL_ENTRIES = 400;

ipcMain.handle('read-journal', async () => {
  try {
    if (fs.existsSync(journalPath)) {
      const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (Array.isArray(parsed?.entries)) {
        return { entries: parsed.entries.slice(-MAX_JOURNAL_ENTRIES) };
      }
    }
  } catch (err: any) {
    console.error('[Journal] could not read:', err.message);
  }
  return { entries: [] };
});

ipcMain.handle('save-journal', async (_event, entries: any[]) => {
  try {
    const list = Array.isArray(entries) ? entries.slice(-MAX_JOURNAL_ENTRIES) : [];
    fs.writeFileSync(journalPath, JSON.stringify({ entries: list }, null, 2), 'utf8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// One reflection pass over that journal.
//
// A sibling of start-background-task and not the same handler: that one is
// search-grounded, capped at two spoken sentences and broadcast to be read
// aloud. This one wants JSON, no search, and no announcement - nobody is
// waiting to speak it, so it simply returns its answer to the caller.
const REFLECTION_TIMEOUT_MS = 60000;

ipcMain.handle(
  'run-reflection',
  async (_event, { prompt, apiKey }: { prompt: string; apiKey: string }) => {
    if (!apiKey || !apiKey.trim()) return { success: false, error: 'No Gemini API key configured.' };
    if (!prompt || !prompt.trim()) return { success: false, error: 'No prompt supplied.' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFLECTION_TIMEOUT_MS);

    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json'
      }
    });

    try {
      let lastError = 'no model was reachable';

      // Same chain and same memory of what worked as the background path: model
      // eligibility differs per API key, and paying for that discovery twice
      // per run is the thing that memory exists to avoid.
      for (let attempt = 0; attempt < BACKGROUND_MODELS.length; attempt++) {
        const index = (lastWorkingBackgroundModel + attempt) % BACKGROUND_MODELS.length;
        const model = BACKGROUND_MODELS[index];

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body
          }
        );

        if (res.ok) {
          const data: any = await res.json();
          const text = (data?.candidates?.[0]?.content?.parts || [])
            .map((part: any) => part.text)
            .filter(Boolean)
            .join('')
            .trim();
          if (!text) {
            lastError = 'the model returned nothing';
            continue;
          }
          lastWorkingBackgroundModel = index;
          console.log(`[Hermes] reflection answered by ${model}`);
          return { success: true, text };
        }

        const detail = await res.text().catch(() => '');
        lastError = `${res.status} ${detail.slice(0, 200)}`;
        console.warn(`[Hermes] ${model} refused the reflection: ${lastError}`);
        // Anything other than quota or eligibility is not going to go better on
        // the next model, so stop paying for handshakes to find that out.
        if (res.status !== 429 && res.status !== 403 && res.status !== 404) break;
      }

      return { success: false, error: lastError };
    } catch (err: any) {
      return {
        success: false,
        error: err?.name === 'AbortError' ? 'the reflection timed out' : err?.message || 'failed'
      };
    } finally {
      clearTimeout(timer);
    }
  }
);

ipcMain.handle('read-memory', async () => {
  try {
    if (fs.existsSync(memoryPath)) {
      const content = fs.readFileSync(memoryPath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Failed to read memory store:', err);
  }
  return {
    tasks: [],
    history: [],
    notes: []
  };
});

ipcMain.handle('save-memory', async (_event, memoryData: any) => {
  try {
    // Union history with whatever is on disk instead of overwriting it.
    //
    // The renderer holds its own copy and saves it whole, so a message written
    // by anyone else between its load and its save was silently lost - which is
    // exactly what the phone sync does. Measured: a pushed message vanished on
    // the next desktop save. Last-writer-wins is wrong once there is a second
    // writer, and there is.
    let merged = memoryData;
    try {
      if (fs.existsSync(memoryPath)) {
        const onDisk = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
        const incoming = Array.isArray(memoryData?.history) ? memoryData.history : [];
        const seen = new Set(incoming.map((m: any) => m?.id));
        const missed = (onDisk.history || []).filter((m: any) => m?.id && !seen.has(m.id));
        if (missed.length) {
          console.log(`[Memory] preserved ${missed.length} message(s) written by another writer`);
          // Ordered by when each was recorded, so a merge does not scramble the
          // conversation into two interleaved halves.
          merged = {
            ...memoryData,
            history: [...missed, ...incoming].slice(-500)
          };
        }
      }
    } catch (mergeErr: any) {
      console.warn('[Memory] could not merge with the file on disk:', mergeErr.message);
    }

    fs.writeFileSync(memoryPath, JSON.stringify(merged, null, 2), 'utf8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

