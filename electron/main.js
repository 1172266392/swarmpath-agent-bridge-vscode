/**
 * SwarmPath Agent Bridge — Electron Main Process
 *
 * Runs the Fastify server directly in the main process (no child process).
 * BrowserWindow loads the server's HTTP endpoint.
 */

import { app, BrowserWindow, Tray, Menu, shell, nativeImage } from 'electron';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// macOS apps launched from Finder inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// Fix: read the full PATH from the user's login shell — same approach as VS Code / Atom.
// This works on any Mac regardless of how Node was installed (nvm, homebrew, volta, etc.).
if (process.platform === 'darwin' && !isDev) {
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    const shellPath = execSync(`${userShell} -ilc 'echo -n "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    // Fallback: leave PATH as-is
  }
}

let mainWindow = null;
let tray = null;
let fastifyApp = null;
const PORT = parseInt(process.env.PORT || '3300', 10);

// ---------------------------------------------------------------------------
// Server lifecycle — runs in-process, no child process needed
// ---------------------------------------------------------------------------

async function startServer() {
  // Set environment before importing the server module
  const bridgeRoot = isDev
    ? path.join(__dirname, '..')
    : path.join(process.resourcesPath, 'app');

  process.env.PORT = String(PORT);
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.BRIDGE_ROOT = bridgeRoot;
  process.env.ELECTRON = '1';

  // Ensure data dir exists
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

  // Change cwd to bridge root so relative paths work
  process.chdir(bridgeRoot);

  // Load .env (same as index.ts does via `import 'dotenv/config'`)
  const envPath = path.join(bridgeRoot, '.env');
  if (fs.existsSync(envPath)) {
    const { config } = await import('dotenv');
    config({ path: envPath });
  }

  // Dynamically import the server module
  const serverPath = isDev
    ? path.join(__dirname, '..', 'dist', 'server.js')
    : path.join(process.resourcesPath, 'app', 'dist', 'server.js');

  const { createServer } = await import(serverPath);
  fastifyApp = await createServer();

  await fastifyApp.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[electron] Server running at http://localhost:${PORT}`);
}

async function stopServer() {
  if (fastifyApp) {
    await fastifyApp.close();
    fastifyApp = null;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Show loading page while server boots
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // macOS: hide instead of quit on window close
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  const iconPath = path.join(__dirname, 'icon-tray.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('SwarmPath Agent Bridge');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Window', click: () => mainWindow?.show() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => mainWindow?.show());
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  createWindow();
  createTray();

  try {
    await startServer();
    mainWindow.loadURL(`http://localhost:${PORT}`);
  } catch (err) {
    console.error('[electron] Failed to start server:', err);
    mainWindow.webContents.executeJavaScript(
      `document.body.innerHTML = '<div style="text-align:center;padding:2em;color:#f38ba8"><h2>Failed to start server</h2><p>${String(err).replace(/'/g, "\\'")}</p></div>'`,
    );
  }
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  await stopServer();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
