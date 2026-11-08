import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { startLink } from "./link/service";
import { createStt } from "./voice/stt";
import { setupBackground } from "./background";

let win: BrowserWindow | undefined;
let bg: ReturnType<typeof setupBackground> | undefined;

// One Solo at a time: launching it again (shortcut, wake word helper) just shows the running one.
if (!app.requestSingleInstanceLock()) app.quit();

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180, height: 760, minWidth: 860, minHeight: 600,
    backgroundColor: "#0b0d12", title: "Solo",
    show: !process.argv.includes("--hidden"), // started with Windows: stay in the tray
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, // keep the microphone pipeline running at full speed while the window is hidden
    },
  });
  win = w;
  w.on("close", (e) => { bg?.interceptClose(e, w); });
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("http://localhost")) e.preventDefault(); });
  if (process.env["ELECTRON_RENDERER_URL"]) w.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else w.loadFile(join(__dirname, "../renderer/index.html"));
  return w;
}

app.whenReady().then(async () => {
  // Deny every permission request (mic etc.) until the voice phase wires explicit, user-controlled grants.
  // Microphone: granted only while the user has the mic switched on in Solo (flag set over IPC), and only to our own UI.
  let micAllowed = false;
  const ours = (url: string) => url.startsWith("file://") || url.startsWith("http://localhost");
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) =>
    cb(perm === "media" && micAllowed && ours(details.requestingUrl) && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") !== false));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => perm === "media" && micAllowed && ours(origin));
  ipcMain.handle("voice:setMicAllowed", (_e, on: unknown) => { micAllowed = on === true; });
  const stt = createStt({ cacheDir: join(app.getPath("userData"), "models") });
  ipcMain.handle("voice:warmup", async (e) => {
    try { await stt.warmup((p) => e.sender.send("voice:modelProgress", p)); return { ok: true as const }; }
    catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("voice:transcribe", async (_e, pcm: unknown) => {
    if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > 16000 * 30) return "";
    return stt.transcribe(pcm);
  });
  ipcMain.handle("solo:version", () => app.getVersion());

  const link = await startLink(
    () => win?.webContents.send("link:changed", link.snapshot()),
    (d) => win?.webContents.send("sync:changed", { table: d.table, rowId: d.rowId, data: d.deleted ? undefined : d.data }),
  );
  const TABLES = ["settings", "memories", "tasks", "conversations"] as const;
  type Table = (typeof TABLES)[number];
  const table = (v: unknown): Table | undefined => TABLES.find((t) => t === v);
  ipcMain.handle("sync:get", (_e, t: unknown, id: unknown) => { const tb = table(t); return tb && typeof id === "string" ? link.sync.get(tb, id) : undefined; });
  ipcMain.handle("sync:set", (_e, t: unknown, id: unknown, data: unknown) => {
    const tb = table(t);
    if (tb && typeof id === "string" && data && typeof data === "object" && !Array.isArray(data)) link.sync.set(tb, id, data as Record<string, unknown>);
  });
  ipcMain.handle("link:snapshot", () => link.snapshot());
  ipcMain.handle("link:startPairing", () => link.startPairing());
  ipcMain.handle("link:cancelPairing", () => link.cancelPairing());
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  ipcMain.handle("link:approve", (_e, id: unknown) => link.approve(str(id)));
  ipcMain.handle("link:deny", (_e, id: unknown) => link.deny(str(id)));
  ipcMain.handle("link:setAutoApprove", (_e, on: unknown) => link.setAutoApprove(on === true));
  ipcMain.handle("link:renameDevice", (_e, id: unknown, name: unknown) => link.renameDevice(str(id), str(name)));
  ipcMain.handle("link:renameSelf", (_e, name: unknown) => link.renameSelf(str(name)));
  ipcMain.handle("link:setRelayUrl", (_e, url: unknown) => link.setRelayUrl(str(url)));
  ipcMain.handle("link:relayHost", () => link.relayHostPairing());
  ipcMain.handle("link:relayCancel", () => link.relayCancelPairing());
  ipcMain.handle("link:relayJoin", (_e, code: unknown) => link.relayJoin(str(code)));
  ipcMain.handle("link:revoke", (_e, id: unknown) => { if (typeof id === "string") link.revoke(id); });
  ipcMain.handle("link:remove", (_e, id: unknown) => { if (typeof id === "string") link.remove(id); });
  app.on("before-quit", () => { void link.stop(); });

  bg = setupBackground({ file: join(app.getPath("userData"), "background.json"), createWindow, getWindow: () => win });
  ipcMain.handle("app:getBackground", () => ({ ...bg!.settings, visible: bg!.isVisible() }));
  ipcMain.handle("app:setBackground", (_e, patch: unknown) => (patch && typeof patch === "object" ? bg!.set(patch as object) : bg!.settings));
  ipcMain.handle("app:reveal", () => bg!.reveal());
  ipcMain.handle("app:quit", () => bg!.quit());

  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
