import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "node:path";

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 800, minHeight: 560,
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

app.whenReady().then(() => {
  // Deny every permission request (mic etc.) until the voice phase wires explicit, user-controlled grants.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ipcMain.handle("solo:version", () => app.getVersion());
  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
