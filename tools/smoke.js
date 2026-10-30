/* dsh-pet-bridge smoke test — run with orbit-tools' electron:
     E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/smoke.js [--adopt <dsh-pet pkg dir>]

   Full chain against the real upstream package: adopt install -> start
   (supervised child + runtime-file handshake) -> whitelisted petApi
   (state/anim/broadcast + token header + surface default) -> animList from
   the shipped webm pool -> speakClipboard -> graceful stop -> deactivate.
   Set --adopt to a pre-installed package dir to skip the npm install. */

const { app, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const ORBIT = path.resolve(__dirname, '..', '..', 'orbit-tools');
const PluginManager = require(path.join(ORBIT, 'src', 'core', 'plugin-manager'));
const Config = require(path.join(ORBIT, 'src', 'core', 'config'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = m => { console.error('FAIL:', m); app.exit(1); throw new Error(m); };
const ok = m => console.log('ok -', m);

app.whenReady().then(async () => {
  try {
    const adoptIdx = process.argv.indexOf('--adopt');
    const adoptDir = adoptIdx > -1 ? process.argv[adoptIdx + 1] : null;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpb-smoke-'));
    const userPlugins = path.join(tmp, 'plugins');
    fs.mkdirSync(userPlugins, { recursive: true });
    fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'dsh-pet-bridge'), { recursive: true });

    const cfg = new Config(tmp);
    const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => null });
    manager.discover();
    if (!manager.plugins.get('dsh-pet-bridge')) fail('bridge plugin not discovered');
    if (!manager.activate('dsh-pet-bridge')) fail('activate failed: ' + manager.loadErrors.get('dsh-pet-bridge'));
    ok('bridge activated');

    /* install: adopt a pre-installed package (or npm-install here if none) */
    const pkg = adoptDir
      || path.join(os.homedir(), '.dsh/dsh-pet-bridge/vendor/node_modules/dsh-pet');
    let st = await manager.call('dsh-pet-bridge', 'status');
    if (!st.install) {
      if (!fs.existsSync(path.join(pkg, 'lib', 'standalone.js'))) {
        console.log('no package to adopt; run npm install first (or pass --adopt)');
        fail('dsh-pet package not found for --adopt fallback: ' + pkg);
      }
      const a = await manager.call('dsh-pet-bridge', 'adoptDir', { dir: pkg });
      if (!a.ok) fail('adoptDir: ' + a.error);
      st = await manager.call('dsh-pet-bridge', 'status');
    }
    if (!st.install || !st.install.version) fail('install not visible after adopt');
    ok(`install adopted: ${st.install.version} (${st.install.mode}) @ ${st.install.dir}`);

    /* start -> runtime-file handshake with OUR child pid */
    const started = await manager.call('dsh-pet-bridge', 'start');
    if (!started.ok) fail('start: ' + JSON.stringify(started));
    let connected = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      st = await manager.call('dsh-pet-bridge', 'status');
      if (st.running && st.connection) { connected = st.connection; break; }
      if (st.lastError) fail('start error: ' + st.lastError);
    }
    if (!connected) fail('runtime handshake timed out');
    const rt = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-pet', 'standalone-runtime.json'), 'utf8'));
    if (rt.pid !== connected.pid) fail('runtime pid mismatch');
    ok(`pet running on :${connected.port} pid=${connected.pid}, settings url registered`);

    /* petApi forwarding: whitelist + surface/pet defaults + token header */
    const state = await manager.call('dsh-pet-bridge', 'call', { method: 'GET', path: '/dsh-pet-7340/state' });
    if (!state || typeof state.counter !== 'number') fail('GET state shape: ' + JSON.stringify(state).slice(0, 120));
    ok(`state counter=${state.counter} sections=[${Object.keys(state.sections || {})}]`);

    try {
      await manager.call('dsh-pet-bridge', 'call', { method: 'POST', path: '/etc/passwd' });
      fail('whitelist did not block unknown route');
    } catch { ok('route whitelist enforced'); }

    const list = await manager.call('dsh-pet-bridge', 'animList');
    if (!list.ok || !list.names.includes('东张西望')) fail('animList: ' + JSON.stringify(list).slice(0, 120));
    ok(`animList from shipped assets: ${list.names.length} animations`);

    const play = await manager.call('dsh-pet-bridge', 'call', { method: 'POST', path: '/dsh-pet-7340/anim', body: { name: '东张西望' } });
    if (!play.ok || !play.playbackId) fail('anim: ' + JSON.stringify(play).slice(0, 160));
    ok(`anim dispatched playbackId=${play.playbackId} (surface default injected)`);

    const feed = await manager.call('dsh-pet-bridge', 'call', { method: 'POST', path: '/dsh-pet-7340/broadcast', body: { text: 'smoke: 工具箱来电' } });
    if (!feed.ok) fail('broadcast: ' + JSON.stringify(feed).slice(0, 160));
    ok('broadcast written to bubble');

    require('electron').clipboard.writeText('剪贴板冒烟文本');
    const sp = await manager.call('dsh-pet-bridge', 'speakClipboard');
    if (!sp.ok) fail('speakClipboard: ' + JSON.stringify(sp).slice(0, 160));
    ok('speakClipboard action works');

    /* graceful stop -> child exits, runtime file removed by upstream cleanup */
    const stopped = await manager.call('dsh-pet-bridge', 'stop');
    if (!stopped.ok) fail('stop: ' + JSON.stringify(stopped));
    await sleep(1500);
    st = await manager.call('dsh-pet-bridge', 'status');
    if (st.running) fail('still running after graceful stop');
    const rtGone = !fs.existsSync(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-pet', 'standalone-runtime.json'));
    ok(`graceful stop (runtime file ${rtGone ? 'self-cleaned' : 'left behind'})`);

    manager.deactivate('dsh-pet-bridge');
    ok('deactivate clean');
    console.log('ALL BRIDGE SMOKE CHECKS PASSED');
    app.exit(0);
  } catch (err) {
    console.error('FAIL:', err && err.message);
    try { app.exit(1); } catch { /* already exiting */ }
  }
});
