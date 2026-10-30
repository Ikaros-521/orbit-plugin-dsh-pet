/* Panel visual check for the bridge — boots the REAL orbit-tools renderer,
   adopts the installed dsh-pet, opens the panel, screenshots light/dark.

     electron tools/panel-shot.js [--dark] [--adopt <pkg dir>] [--live]

   --live also starts the pet so the drive section renders populated. */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORBIT = path.resolve(__dirname, '..', '..', 'orbit-tools');
const Config = require(path.join(ORBIT, 'src', 'core', 'config'));
const PluginManager = require(path.join(ORBIT, 'src', 'core', 'plugin-manager'));
const { registerPluginProtocol } = require(path.join(ORBIT, 'src', 'core', 'plugin-protocol'));
const createHotkeys = require(path.join(ORBIT, 'src', 'core', 'hotkeys'));
const registerIpc = require(path.join(ORBIT, 'src', 'core', 'ipc'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const OUT = path.join(os.tmpdir(), 'pet-frames');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const LIVE = process.argv.includes('--live');

async function shotTheme(theme) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dpb-panel-${theme}-`));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'dsh-pet-bridge'), { recursive: true });
  const cfg = new Config(tmp);
  cfg.set({ theme });
  let win = null;
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => win });
  const hotkeys = createHotkeys({ cfg, manager, onSummon: () => {} });
  registerPluginProtocol(manager);
  registerIpc({ app, cfg, manager, hotkeys, getHostWindow: () => win });
  manager.discover();
  for (const p of manager.plugins.values()) if (p.enabled) manager.activate(p.id);

  if (arg('--adopt')) await manager.call('dsh-pet-bridge', 'adoptDir', { dir: arg('--adopt') });
  if (LIVE) await manager.call('dsh-pet-bridge', 'start');

  win = new BrowserWindow({
    show: false, width: 980, height: 760,
    webPreferences: {
      preload: path.join(ORBIT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) console.log(`[renderer err] ${msg.slice(0, 180)}`); });
  await win.loadFile(path.join(ORBIT, 'src', 'renderer', 'index.html'));
  await sleep(800);
  if (LIVE) {
    for (let i = 0; i < 60; i++) { await sleep(500); const s = await manager.call('dsh-pet-bridge', 'status'); if (s.running) break; }
  }
  win.webContents.send('open-plugin', 'dsh-pet-bridge');
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const mounted = await win.webContents.executeJavaScript('!!document.querySelector(".dpb-root .dpb-status-line")');
    if (mounted) break;
  }
  await sleep(800);
  const state = await win.webContents.executeJavaScript(`({
    line: (document.querySelector('.dpb-status-line') || {}).textContent,
    sub: ((document.querySelector('.dpb-status-sub') || {}).textContent || '').slice(0, 40),
    start: (document.querySelector('.dpb-start') || {}).textContent,
    driveHidden: (document.querySelector('.dpb-drive') || { classList: { contains: () => null } }).classList.contains('dpb-hidden'),
    animCount: (document.querySelector('.dpb-anim-select') || {}).length,
  })`);
  const png = path.join(OUT, `bridge-panel-${theme}.png`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(png, (await win.webContents.capturePage()).toPNG());
  console.log(`SHOT ${theme}: ${JSON.stringify(state)} -> ${png}`);
  await manager.call('dsh-pet-bridge', 'stop');
  await sleep(1000);
  manager.deactivateAll();
  win.destroy();
}

app.whenReady().then(async () => {
  const theme = process.argv.includes('--dark') ? 'dark' : 'light';
  try { await shotTheme(theme); } catch (e) { console.error('PANEL_SHOT_ERR', e.message); app.exit(1); return; }
  app.exit(0);
});
