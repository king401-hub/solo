import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { startLink } from "./link/service";

let win: BrowserWindow | undefined;

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 860, minHeight: 600,
    backgroundColor: "#0b0d12", title: "Solo",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("http://localhost")) e.preventDefault(); });
  if (process.env["ELECTRON_RENDERER_URL"]) win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  // Deny every permission request (mic etc.) until the voice phase wires explicit, user-controlled grants.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ipcMain.handle("solo:version", () => app.getVersion());

  const link = await startLink(() => win?.webContents.send("link:changed", link.snapshot()));
  ipcMain.handle("link:snapshot", () => link.snapshot());
  ipcMain.handle("link:startPairing", () => link.startPairing());
  ipcMain.handle("link:cancelPairing", () => link.cancelPairing());
  ipcMain.handle("link:revoke", (_e, id: unknown) => { if (typeof id === "string") link.revoke(id); });
  ipcMain.handle("link:remove", (_e, id: unknown) => { if (typeof id === "string") link.remove(id); });
  app.on("before-quit", () => { void link.stop(); });

  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
