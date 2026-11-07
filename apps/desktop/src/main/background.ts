import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BgSettings {
  /** Closing the window hides Solo to the tray instead of quitting, so it can keep listening. */
  runInBackground: boolean;
  /** Launch with Windows, hidden in the tray. */
  startWithWindows: boolean;
  /** Turn the microphone on automatically when Solo starts. Opt-in: it is the only way wake words work after a reboot. */
  autoListen: boolean;
}
export const defaultBg: BgSettings = { runInBackground: true, startWithWindows: false, autoListen: false };

export function loadBg(file: string): BgSettings {
  try { return { ...defaultBg, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { return { ...defaultBg }; }
}

/** 32x32 purple orb for the tray, drawn in code so we ship no binary asset. */
export function trayIcon() {
  const size = 32, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - 15.5, dy = y - 15.5, d = Math.sqrt(dx * dx + dy * dy), i = (y * size + x) * 4;
    const inside = d <= 14;
    const shine = Math.max(0, 1 - Math.hypot(x - 11, y - 10) / 14);
    buf[i] = inside ? Math.min(255, 0xe7 + shine * 40) : 0; // B
    buf[i + 1] = inside ? Math.min(255, 0x5c + shine * 120) : 0; // G
    buf[i + 2] = inside ? Math.min(255, 0x6c + shine * 120) : 0; // R
    buf[i + 3] = inside ? 255 : d <= 15 ? 90 : 0; // A (soft edge)
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/**
 * Tray + background behaviour. The renderer (which owns the microphone) stays alive while the window is hidden,
 * so wake words keep working after the window is closed. Quitting from the tray really stops everything.
 */
export function setupBackground(opts: { file: string; createWindow: () => BrowserWindow; getWindow: () => BrowserWindow | undefined }) {
  let settings = loadBg(opts.file);
  let quitting = false;
  let tray: Tray | undefined;

  const save = () => { mkdirSync(dirname(opts.file), { recursive: true }); writeFileSync(opts.file, JSON.stringify(settings)); };

  const reveal = () => {
    let w = opts.getWindow();
    if (!w || w.isDestroyed()) w = opts.createWindow();
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  };

  const applyLoginItem = () => {
    // Unpackaged (dev) runs register electron.exe + the app path; a packaged build registers itself.
    const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];
    app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, path: process.execPath, args });
  };

  const buildTray = () => {
    if (tray) return;
    tray = new Tray(trayIcon());
    tray.setToolTip("Solo");
    tray.on("click", reveal);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Solo", click: reveal },
      { type: "separator" },
      { label: "Quit Solo (stops listening)", click: () => { quitting = true; app.quit(); } },
    ]));
  };

  app.on("before-quit", () => { quitting = true; });
  app.on("second-instance", reveal); // starting Solo again just brings the running one forward
  buildTray();
  applyLoginItem();

  return {
    get settings() { return settings; },
    set(patch: Partial<BgSettings>) {
      settings = { ...settings, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in defaultBg && typeof v === "boolean")) } as BgSettings;
      save();
      applyLoginItem();
      return settings;
    },
    reveal,
    /** Call from the window's "close" event. Returns true if the close was turned into a hide. */
    interceptClose(e: { preventDefault(): void }, w: BrowserWindow) {
      if (quitting || !settings.runInBackground) return false;
      e.preventDefault();
      w.hide();
      return true;
    },
    quit() { quitting = true; app.quit(); },
    isVisible: () => { const w = opts.getWindow(); return !!w && !w.isDestroyed() && w.isVisible(); },
    startHidden: process.argv.includes("--hidden"),
  };
}

export const bgFileExists = (f: string) => existsSync(f);
