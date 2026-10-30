/* dsh-pet-bridge backend.
   Runs the OFFICIAL dsh-pet in standalone mode as a supervised child process
   and exposes its HTTP contract to the toolbox: install / start-stop /
   health / route-table forwarding (speak, play animations, read state).

   Why process takeover instead of in-process embedding: standalone IS
   dsh-pet's official "host the plugin on a pseudo-ctx without DSH" mode —
   service discovery via ~/.dsh/dsh-pet/standalone-runtime.json (port +
   capability token), Electron runtime auto-fetched by the plugin itself.
   Zero source modification means upgrades stay in lockstep with upstream
   and the CC BY-NC-SA character assets never enter this repo (npm-owned).

   The child runs standalone.js under ELECTRON_RUN_AS_NODE: the toolbox's
   own Electron binary doubles as the Node host, so users need no separate
   Node.js install for the npm-pack layout.

   Shutdown chain (verified upstream): POST /shutdown disposes the plugin
   effects, which stops the desktop helper grandchild. Any non-graceful
   teardown (toolbox quit, disable) kills the whole tree synchronously —
   the same orphan-process lesson that fixed our MCP/shell quit race. */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clipboard, dialog } = require('electron');

const P = 'dsh-pet-bridge:';
const ROUTE = '/dsh-pet-7340';           // fixed upstream route prefix
const HEALTH_MS = 15000;
const CONNECT_TIMEOUT_MS = 150000;       // covers the one-time Electron download

let teardown = null;

/* --- upstream file locations ------------------------------------------------- */

const dshHome = () => process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || osHome(), '.dsh');
function osHome() { return require('os').homedir(); }
const runtimeFile = () => path.join(dshHome(), 'dsh-pet', 'standalone-runtime.json');

const readRuntime = () => {
  try { return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8')); } catch { return null; }
};

/* An install is either the npm layout (lib/standalone.js) or a green-package
   folder (dsh-pet.exe). Both speak the same runtime-file contract. */
function classifyInstall(dir) {
  if (!dir) return null;
  try {
    if (fs.existsSync(path.join(dir, 'lib', 'standalone.js'))) {
      let version = '0.0.0';
      try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || version; } catch { /* default */ }
      return { mode: 'node', dir, version, entry: path.join(dir, 'lib', 'standalone.js') };
    }
    const exe = process.platform === 'win32' ? 'dsh-pet.exe' : 'dsh-pet';
    if (fs.existsSync(path.join(dir, exe))) return { mode: 'exe', dir, version: 'green', entry: path.join(dir, exe) };
  } catch { /* unreadable dir */ }
  return null;
}

module.exports = {
  activate(ctx) {
    /* --- prefs --------------------------------------------------------------- */

    const vendorRoot = path.join(dshHome(), 'dsh-pet-bridge', 'vendor');
    const defaults = {
      installDir: null,          // null => vendorRoot/node_modules/dsh-pet
      petId: 'main',
      port: 0,                   // 0 => upstream default (auto-shifts if busy)
      autoStart: false,
      registry: 'https://registry.npmmirror.com',
      npmProxy: '',              // optional http://127.0.0.1:PORT for npm
    };
    const prefs = { ...defaults, ...ctx.data.get() };
    const save = () => ctx.data.set(prefs);

    const installDir = () => prefs.installDir || path.join(vendorRoot, 'node_modules', 'dsh-pet');
    let install = classifyInstall(installDir());

    /* --- supervised process --------------------------------------------------- */

    let child = null;
    let connection = null;  // {port, token, settingsUrl, pid} from runtime file
    let connectTimer = null;
    let healthTimer = null;
    let lastError = null;
    let logStream = null;
    const logFile = () => path.join(vendorRoot, 'standalone.log');

    const logTail = (n = 400) => {
      try {
        const s = fs.readFileSync(logFile(), 'utf8');
        return s.length > n ? s.slice(-n) : s;
      } catch { return ''; }
    };

    const brief = () => ({
      install: install ? { mode: install.mode, dir: install.dir, version: install.version } : null,
      vendorRoot,
      dshHome: dshHome(),
      running: !!connection && !!child && !child.killed,
      connection: connection ? { port: connection.port, pid: connection.pid, settingsUrl: connection.settingsUrl } : null,
      prefs: { petId: prefs.petId, port: prefs.port, autoStart: prefs.autoStart, registry: prefs.registry, npmProxy: prefs.npmProxy },
      lastError,
    });
    const push = () => ctx.send('status', brief());

    /* Claim the runtime file only when it is OUR child's: the pid must match
       and the token must differ from the pre-spawn one (survives stale files). */
    function watchRuntime(oldToken, onDone) {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      const tick = () => {
        const rt = readRuntime();
        if (rt && rt.pid === child?.pid && rt.token && rt.token !== oldToken) {
          connection = rt;
          onDone?.(true);
          push();
          return;
        }
        if (Date.now() > deadline) {
          lastError = `桌宠未在 ${Math.round(CONNECT_TIMEOUT_MS / 1000)} 秒内完成注册（首次启动需下载 Electron 运行时，约 130MB，请稍后点“重试连接”或查看日志）`;
          onDone?.(false);
          push();
          return;
        }
        connectTimer = setTimeout(tick, 400);
      };
      tick();
    }

    async function start() {
      if (child && !child.killed) return { ok: true, note: 'already starting/running' };
      install = classifyInstall(installDir());
      if (!install) return { ok: false, error: 'dsh-pet 未安装：先“一键安装”或选择已有目录' };
      lastError = null;

      const preToken = readRuntime()?.token || '';
      try { fs.mkdirSync(vendorRoot, { recursive: true }); } catch { /* best effort */ }
      try { logStream = fs.createWriteStream(logFile(), { flags: 'a' }); } catch { logStream = null; }

      const args = [];
      if (install.mode === 'node') args.push(install.entry);
      if (prefs.port >= 1 && prefs.port <= 65535) args.push('--port', String(prefs.port));
      const opts = {
        cwd: install.dir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      };
      if (install.mode === 'node') {
        // toolbox's own Electron binary, in pure-Node mode: no user Node.js needed
        opts.env.ELECTRON_RUN_AS_NODE = '1';
        child = spawn(process.execPath, args, opts);
      } else {
        child = spawn(install.entry, args.filter(a => a !== install.entry), opts);
      }
      child.stdout?.on('data', d => logStream?.write(String(d)));
      child.stderr?.on('data', d => logStream?.write(String(d)));
      child.on('exit', (code, signal) => {
        logStream?.write(`\n---- child exit code=${code} signal=${signal} ----\n`);
        logStream?.end(); logStream = null;
        child = null; connection = null;
        clearTimeout(connectTimer);
        clearInterval(healthTimer); healthTimer = null;
        if (code !== 0 && code !== null) lastError = `桌宠进程退出码 ${code}：${logTail(200)}`;
        push();
      });
      child.on('error', err => {
        lastError = '启动失败：' + err.message;
        child = null; push();
      });

      watchRuntime(preToken, (up) => {
        if (!up) { push(); return; }
        clearInterval(healthTimer);
        healthTimer = setInterval(async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${connection.port}/health`, { signal: AbortSignal.timeout(5000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
          } catch (err) {
            lastError = '健康检查失败：' + err.message;
            clearInterval(healthTimer); healthTimer = null;
            push();
          }
        }, HEALTH_MS);
        healthTimer.unref?.();
      });
      push();
      return { ok: true };
    }

    function killTreeSync(pid) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        else process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }

    async function stop({ graceful = true } = {}) {
      if (!child) {
        // not ours — offer to stop an external standalone via the runtime file
        const rt = readRuntime();
        if (rt && graceful) {
          try {
            await fetch(`http://127.0.0.1:${rt.port}/shutdown`, {
              method: 'POST', headers: { 'x-dsh-pet-token': rt.token }, signal: AbortSignal.timeout(8000),
            });
            connection = { port: rt.port, token: rt.token }; // cleared by watch on file removal
          } catch { /* already down */ }
        }
        connection = null; push();
        return { ok: true };
      }
      const pid = child.pid;
      if (graceful) {
        try {
          await fetch(`http://127.0.0.1:${(connection || readRuntime() || {}).port || 0}/shutdown`, {
            method: 'POST', headers: { 'x-dsh-pet-token': (connection || {}).token || readRuntime()?.token || '' },
            signal: AbortSignal.timeout(6000),
          });
        } catch { /* fall through to tree kill */ }
        const gone = await new Promise(res => {
          const t = setTimeout(() => res(false), 4000);
          child?.once?.('exit', () => { clearTimeout(t); res(true); });
          if (!child) { clearTimeout(t); res(true); }
        });
        if (gone) return { ok: true };
      }
      killTreeSync(pid);
      return { ok: true };
    }

    /* Adopt an already-running standalone we did not spawn (green-package
       double-click, DSH host, another terminal): attach by runtime file. */
    function reconnect() {
      const rt = readRuntime();
      if (!rt || !rt.port || !rt.token) return { ok: false, error: '未发现运行中的 dsh-pet（standalone-runtime.json 不存在）' };
      let alive = false;
      try { process.kill(rt.pid, 0); alive = true; } catch { /* dead */ }
      if (!alive && rt.pid !== child?.pid) {
        // pid not visible to us (different session/elevated) — trust /health
        fetch(`http://127.0.0.1:${rt.port}/health`, { signal: AbortSignal.timeout(3000) })
          .then(r => r.ok && (connection = rt, push()))
          .catch(() => {});
      }
      connection = rt;
      push();
      return { ok: true, connection: { port: rt.port, pid: rt.pid, settingsUrl: rt.settingsUrl } };
    }

    /* --- route forwarding (petApi) ------------------------------------------ */

    const ALLOW = new Set([
      'GET /health', `GET ${ROUTE}/state`, `GET ${ROUTE}/pose`, `GET ${ROUTE}/config`,
      `GET ${ROUTE}/chat`, `GET ${ROUTE}/models`,
      `POST ${ROUTE}/whisper`, `POST ${ROUTE}/broadcast`, `POST ${ROUTE}/bubble/clear`,
      `POST ${ROUTE}/anim`, `POST ${ROUTE}/position`, `POST ${ROUTE}/throw`,
      `POST ${ROUTE}/chat`, `DELETE ${ROUTE}/chat`, `POST ${ROUTE}/balance`,
      `POST ${ROUTE}/lock`, `POST ${ROUTE}/lock/release`,
    ]);

    async function call(method, routePath, { query = {}, body } = {}) {
      const rt = connection || readRuntime();
      if (!rt?.port) throw new Error('桌宠未在运行');
      if (!ALLOW.has(`${method} ${routePath}`)) throw new Error(`路由不在白名单：${method} ${routePath}`);
      const url = new URL(`http://127.0.0.1:${rt.port}${routePath}`);
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      const headers = { 'x-dsh-pet-token': rt.token };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(45000), // upstream allows LLM turns up to ~60s; 45s is the bridge budget
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      return json;
    }

    /* surface=any: the bridge does not care which end renders; standalone
       runs the desktop helper, and web overlays simply do not exist here. */
    const api = {
      status: () => {
        install = classifyInstall(installDir());
        return brief();
      },
      setPrefs: (args = {}) => {
        for (const k of ['petId', 'installDir', 'registry', 'npmProxy']) if (typeof args[k] === 'string') prefs[k] = args[k];
        if (typeof args.port === 'number') prefs.port = Math.max(0, Math.min(65535, Math.round(args.port)));
        if (typeof args.autoStart === 'boolean') prefs.autoStart = args.autoStart;
        save(); push();
        return { ok: true };
      },
      start: () => start(),
      stop: () => stop(),
      toggle: async () => {
        if (child && !child.killed || readRuntime()) return await stop();
        return await start();
      },
      reconnect: () => reconnect(),
      openSettings: () => {
        const rt = connection || readRuntime();
        if (!rt?.settingsUrl) return { ok: false, error: '桌宠未在运行，无法打开设置页' };
        const win = ctx.windows.create({
          width: 1080, height: 800, minWidth: 720, minHeight: 480,
          title: 'dsh-pet 设置', backgroundColor: '#0a0c0d',
        });
        win.loadURL(rt.settingsUrl);
        win.show();
        return { ok: true };
      },
      /* panel-facing smart proxy: pass through whitelisted calls.
         pet and surface default to the prefs — every interactive route in
         0.3.8 requires ?surface=, and the bridge is a surface-agnostic caller. */
      call: (args = {}) => call(
        String(args.method || 'GET').toUpperCase(),
        String(args.path || `${ROUTE}/state`),
        { query: { pet: prefs.petId, surface: 'any', ...(args.query || {}) }, body: args.body },
      ),
      chooseDir: async () => {
        const host = ctx.getHostWindow && ctx.getHostWindow();
        const res = await dialog.showOpenDialog(
          host && !host.isDestroyed() ? host : undefined,
          { properties: ['openDirectory'], title: '选择 dsh-pet 安装目录' },
        );
        return res.canceled ? { ok: false, canceled: true } : { ok: true, dir: res.filePaths[0] };
      },
      animList: () => {
        const dir = install?.mode === 'node' ? path.join(install.dir, 'assets', 'webm') : null;
        if (!dir) return { ok: false, error: 'dsh-pet 未安装' };
        try {
          const names = fs.readdirSync(dir)
            .filter(f => f.toLowerCase().endsWith('.webm'))
            .map(f => f.slice(0, -5));
          return { ok: true, names: names.sort() };
        } catch (err) { return { ok: false, error: err.message }; }
      },
      /* --- toolbox-native touchpoints --------------------------------------- */
      speakClipboard: async () => {
        const text = clipboard.readText().trim();
        if (!text) return { ok: false, error: '剪贴板没有文本' };
        const rt = connection || readRuntime();
        if (!rt?.port) return { ok: false, error: '桌宠未在运行，已复制文本但需要先启动（动作：启停 DSH 桌宠）' };
        try {
          const r = await call('POST', `${ROUTE}/broadcast`, {
            query: { pet: prefs.petId, surface: 'any' },
            body: { text: text.slice(0, 400) },
          });
          return { ok: !!r.ok, sent: text.slice(0, 60), reason: r.reason };
        } catch (err) { return { ok: false, error: err.message }; }
      },
      whisper: async () => {
        const rt = connection || readRuntime();
        if (!rt?.port) return { ok: false, error: '桌宠未在运行' };
        try {
          return await call('POST', `${ROUTE}/whisper`, { query: { pet: prefs.petId, surface: 'any' } });
        } catch (err) { return { ok: false, error: err.message }; }
      },
    };

    for (const [method, fn] of Object.entries(api)) ctx.ipc.handle(method, fn);

    /* --- npm installer -------------------------------------------------------- */

    let installing = false;
    const installNpm = async () => {
      if (installing) return { ok: false, error: '已有安装任务在进行' };
      installing = true;
      try { fs.mkdirSync(vendorRoot, { recursive: true }); } catch (err) {
        installing = false;
        return { ok: false, error: '无法创建安装目录 ' + vendorRoot + '：' + err.message };
      }
      if (!fs.existsSync(path.join(vendorRoot, 'package.json'))) {
        try { fs.writeFileSync(path.join(vendorRoot, 'package.json'), JSON.stringify({ name: 'dsh-pet-bridge-vendor', private: true }, null, 2)); }
        catch (err) { installing = false; return { ok: false, error: err.message }; }
      }
      const cmd = [
        'npm install dsh-pet@latest --no-fund --no-audit',
        `--registry "${prefs.registry}"`,
        prefs.npmProxy ? `--proxy "${prefs.npmProxy}" --https-proxy "${prefs.npmProxy}"` : '',
      ].filter(Boolean).join(' ');
      ctx.send('install', { line: `$ ${cmd.replace(/"[^"]*"/g, m => m.length > 42 ? m.slice(0, 40) + '…"' : m)}` });
      return new Promise(resolve => {
        const done = (res) => { installing = false; resolve(res); };
        const pro = spawn(cmd, { shell: true, cwd: vendorRoot, windowsHide: true });
        let tail = '';
        pro.stdout?.on('data', d => { tail = (tail + String(d)).slice(-800); ctx.send('install', { line: String(d).trim().slice(0, 200) }); });
        pro.stderr?.on('data', d => { tail = (tail + String(d)).slice(-800); ctx.send('install', { line: '! ' + String(d).trim().slice(0, 200) }); });
        pro.on('error', err => { ctx.send('install', { done: true, ok: false, error: err.message }); done({ ok: false, error: err.message }); });
        pro.on('exit', code => {
          install = classifyInstall(installDir());
          const res = code === 0 && install
            ? { ok: true, install: { mode: install.mode, dir: install.dir, version: install.version } }
            : { ok: false, error: `npm 退出码 ${code}：${tail.slice(-300)}` };
          ctx.send('install', { done: true, ...res });
          push();
          done(res);
        });
      });
    }
    ctx.ipc.handle('installNpm', () => installNpm());

    ctx.ipc.handle('adoptDir', (args = {}) => {
      const info = classifyInstall(String(args.dir || ''));
      if (!info) return { ok: false, error: '所选目录不是 dsh-pet 安装（需要 lib/standalone.js 或 dsh-pet.exe）' };
      prefs.installDir = info.dir; save();
      install = info; push();
      return { ok: true, install: { mode: info.mode, dir: info.dir, version: info.version } };
    });

    /* --- lifecycle ------------------------------------------------------------- */

    let teardownAutoStart = null;
    if (prefs.autoStart && install) {
      const t = setTimeout(() => { start().catch(() => {}); }, 3000);
      t.unref?.();
      teardownAutoStart = () => clearTimeout(t);
    }

    push();

    teardown = () => {
      clearInterval(healthTimer);
      clearTimeout(connectTimer);
      if (teardownAutoStart) teardownAutoStart();
      if (child && !child.killed) killTreeSync(child.pid); // synchronous: no orphans on quit
      if (logStream) { logStream.end(); logStream = null; }
      child = null; connection = null;
    };
  },

  deactivate() { if (teardown) { teardown(); teardown = null; } },
};
