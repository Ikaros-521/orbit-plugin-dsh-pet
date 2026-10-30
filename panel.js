/* dsh-pet bridge panel — install / supervise / drive the official dsh-pet.
   All colours flow through the host light-dark() tokens. */
(function () {
  'use strict';

  const L = () => (window.I18N && window.I18N.lang) === 'en';
  const t = (zh, en) => (L() ? en : zh);

  const ID = 'dsh-pet-bridge';
  const ROUTE = '/dsh-pet-7340';

  window.Toolbox.panel({
    mount(root) {
      // keep the host's panel-view base class (shared rules key off it) and
      // add ours beside it
      root.classList.add('dpb-root');
      let st = null;      // last status snapshot
      let anims = [];     // animation pool names

      root.innerHTML = `
        <div class="dpb-main">
          <div class="dpb-status dpb-group">
            <div class="dpb-led"></div>
            <div class="dpb-status-body">
              <div class="dpb-status-line"></div>
              <div class="dpb-status-sub"></div>
            </div>
            <div class="dpb-status-btns">
              <button type="button" class="dpb-start btn small"></button>
              <button type="button" class="dpb-reconnect btn ghost small"></button>
              <button type="button" class="dpb-settings btn ghost small"></button>
            </div>
          </div>

          <div class="dpb-install dpb-group dpb-hidden">
            <div class="dpb-install-title"></div>
            <div class="dpb-install-row">
              <button type="button" class="dpb-npm btn small"></button>
              <button type="button" class="dpb-adopt btn ghost small"></button>
            </div>
            <pre class="dpb-install-log dpb-hidden"></pre>
          </div>

          <div class="dpb-drive dpb-group dpb-hidden">
            <div class="dpb-drive-title"></div>
            <div class="dpb-say">
              <input class="dpb-text input" type="text" />
              <button type="button" class="dpb-feed btn small"></button>
              <button type="button" class="dpb-whisper btn ghost small"></button>
            </div>
            <div class="dpb-anim">
              <select class="dpb-anim-select input"></select>
              <button type="button" class="dpb-play btn small"></button>
              <button type="button" class="dpb-refresh btn ghost small"></button>
            </div>
            <div class="dpb-result"></div>
          </div>

          <details class="dpb-prefs dpb-group">
            <summary></summary>
            <label class="dpb-row"><input type="checkbox" class="dpb-autostart" /><span></span></label>
            <label class="dpb-row"><span>${t('端口（0=默认）', 'Port (0 = default)')}</span><input type="number" class="dpb-port input" min="0" max="65535" /></label>
            <label class="dpb-row"><span>${t('npm 镜像', 'npm registry')}</span><input type="text" class="dpb-registry input" /></label>
            <label class="dpb-row"><span>${t('npm 代理（可选）', 'npm proxy (optional)')}</span><input type="text" class="dpb-proxy input" placeholder="http://127.0.0.1:10808" /></label>
            <button type="button" class="dpb-save-prefs btn small"></button>
          </details>
        </div>`;

      const $ = cls => root.querySelector(cls);
      const els = {
        led: $('.dpb-led'), line: $('.dpb-status-line'), sub: $('.dpb-status-sub'),
        start: $('.dpb-start'), reconnect: $('.dpb-reconnect'), settings: $('.dpb-settings'),
        install: $('.dpb-install'), installTitle: $('.dpb-install-title'),
        npm: $('.dpb-npm'), adopt: $('.dpb-adopt'), log: $('.dpb-install-log'),
        drive: $('.dpb-drive'), text: $('.dpb-text'), feed: $('.dpb-feed'), whisper: $('.dpb-whisper'),
        anim: $('.dpb-anim-select'), play: $('.dpb-play'), refresh: $('.dpb-refresh'), result: $('.dpb-result'),
        summary: $('summary'), autostart: $('.dpb-autostart'), autostartLabel: $('.dpb-row span'),
        driveTitle: $('.dpb-drive-title'),
        port: $('.dpb-port'), registry: $('.dpb-registry'), proxy: $('.dpb-proxy'), savePrefs: $('.dpb-save-prefs'),
      };

      const call = (method, args) => window.host.pluginCall(ID, method, args);
      const petCall = (method, path, opts = {}) => call('call', { method, path, ...opts });
      /* host wraps every handler result in {ok,data,error?} — unwrap to the
         backend's own envelope so business failures ({ok:false,reason}) land. */
      const unwrap = res => (res && res.ok) ? res.data : { ok: false, error: res && res.error };

      /* --- render ------------------------------------------------------------ */

      const render = () => {
        if (!st) return;
        const running = st.running && st.connection;
        els.led.className = 'dpb-led ' + (running ? 'on' : st.install ? 'idle' : 'off');
        els.line.textContent = running
          ? t(`运行中 · 端口 ${st.connection.port} · pid ${st.connection.pid}`, `Running · port ${st.connection.port} · pid ${st.connection.pid}`)
          : st.install
            ? t('已安装，未运行', 'Installed, not running')
            : t('未安装', 'Not installed');
        els.sub.textContent = st.install
          ? `${st.install.version} · ${st.install.mode === 'exe' ? '绿色包' : 'npm'} · ${st.install.dir}`
          : t(`将安装到 ${st.vendorRoot}`, `Will install to ${st.vendorRoot}`);
        els.start.textContent = running ? t('停止', 'Stop') : t('启动', 'Start');
        els.start.classList.toggle('warn', !!running);
        els.install.classList.toggle('dpb-hidden', !!st.install);
        els.drive.classList.toggle('dpb-hidden', !running);
        els.settings.disabled = !running;
        if (st.lastError) { els.result.textContent = '⚠ ' + st.lastError; }
        // prefs
        els.summary.textContent = t('桥接设置', 'Bridge settings');
        els.autostart.checked = !!st.prefs.autoStart;
        els.autostartLabel.textContent = t('工具箱启动时自动拉起桌宠（随工具箱退出而停止）', 'Auto-start with the toolbox (stops when the toolbox quits)');
        els.port.value = st.prefs.port || 0;
        els.registry.value = st.prefs.registry || '';
        els.proxy.value = st.prefs.npmProxy || '';
        els.npm.textContent = t('一键安装 dsh-pet（npm）', 'Install dsh-pet via npm');
        els.adopt.textContent = t('选择已有安装目录…', 'Adopt existing install dir…');
        els.reconnect.textContent = t('接管外部实例', 'Attach external instance');
        els.settings.textContent = t('打开桌宠设置页', 'Open pet settings');
        els.feed.textContent = t('念这句话', 'Say this');
        els.whisper.textContent = t('自由发挥', 'Ad-lib (AI)');
        els.play.textContent = t('播放', 'Play');
        els.refresh.textContent = t('刷新动作', 'Reload list');
        els.savePrefs.textContent = t('保存设置', 'Save settings');
      };

      const renderAnims = () => {
        const cur = els.anim.value;
        els.anim.innerHTML = anims.map(n => `<option>${n.replace(/</g, '&lt;')}</option>`).join('');
        if (cur && anims.includes(cur)) els.anim.value = cur;
      };

      const flash = (msg) => { els.result.textContent = msg; };

      /* --- actions -------------------------------------------------------------- */

      const refreshStatus = async () => {
        const s = unwrap(await call('status'));
        if (s && s.install !== undefined) { st = s; render(); }
      };

      els.start.addEventListener('click', async () => {
        const running = st && st.running;
        els.start.disabled = true; els.start.textContent = running ? t('停止中…', 'Stopping…') : t('启动中…', 'Starting…');
        const res = unwrap(await call(running ? 'stop' : 'start'));
        els.start.disabled = false;
        if (!res.ok) flash('⚠ ' + (res.error || 'failed'));
        await refreshStatus();
        if (!running) await loadAnims();
      });

      els.reconnect.addEventListener('click', async () => {
        const res = unwrap(await call('reconnect'));
        if (res.ok) { flash(t('已接管外部运行的桌宠', 'Attached to external pet')); await loadAnims(); }
        else flash('⚠ ' + (res.error || 'no external instance'));
        await refreshStatus();
      });

      els.settings.addEventListener('click', () => call('openSettings'));

      const loadAnims = async () => {
        const res = unwrap(await call('animList'));
        if (res.ok && Array.isArray(res.names)) { anims = res.names; renderAnims(); }
      };
      els.refresh.addEventListener('click', loadAnims);

      els.npm.addEventListener('click', async () => {
        els.log.classList.remove('dpb-hidden'); els.log.textContent = ''; els.npm.disabled = true;
        els.npm.textContent = t('安装中…', 'Installing…');
        const res = unwrap(await call('installNpm'));
        els.npm.disabled = false;
        if (res.ok) flash(t('安装完成', 'Installed'));
        else flash('⚠ ' + (res.error || 'install failed'));
        await refreshStatus();
      });

      els.adopt.addEventListener('click', async () => {
        const pick = unwrap(await call('chooseDir'));
        if (!pick.ok || !pick.dir) return;
        const res = unwrap(await call('adoptDir', { dir: pick.dir }));
        if (res.ok) { flash(t('已接入安装目录', 'Adopted')); await refreshStatus(); await loadAnims(); }
        else flash('⚠ ' + (res.error || 'not a dsh-pet install'));
      });

      els.feed.addEventListener('click', async () => {
        const text = els.text.value.trim();
        if (!text) return;
        const res = unwrap(await petCall('POST', `${ROUTE}/broadcast`, { body: { text: text.slice(0, 400) } }));
        if (res.ok) { flash(t('已送进气泡 ✓', 'Sent to bubble ✓')); els.text.value = ''; }
        else flash('⚠ ' + (res.error || res.reason || res.message || 'failed'));
      });

      els.whisper.addEventListener('click', async () => {
        els.whisper.disabled = true; els.whisper.textContent = t('生成中…', 'Generating…');
        const res = unwrap(await call('whisper'));
        els.whisper.disabled = false; els.whisper.textContent = t('自由发挥', 'Ad-lib (AI)');
        if (res.ok) flash(t(`她说了：${(res.text || '').slice(0, 60)}`, `She said: ${(res.text || '').slice(0, 60)}`));
        else flash('⚠ ' + (res.error || res.message || res.reason || t('AI 未配置：先到桌宠设置页配 API key', 'AI not configured: set an API key in pet settings first')));
      });

      els.play.addEventListener('click', async () => {
        if (!els.anim.value) return;
        const res = unwrap(await petCall('POST', `${ROUTE}/anim`, { body: { name: els.anim.value } }));
        if (res.ok) flash(t(`正在播「${els.anim.value}」✓`, `Playing "${els.anim.value}" ✓`));
        else flash('⚠ ' + (res.error || res.reason || 'failed'));
      });

      els.savePrefs.addEventListener('click', async () => {
        await call('setPrefs', {
          autoStart: els.autostart.checked,
          port: Number(els.port.value) || 0,
          registry: els.registry.value.trim(),
          npmProxy: els.proxy.value.trim(),
        });
        flash(t('已保存 ✓', 'Saved ✓'));
        await refreshStatus();
      });

      /* --- events ------------------------------------------------------------ */

      const offStatus = window.host.onPluginEvent(ID, ({ channel, payload }) => {
        if (channel === 'status') { st = payload; render(); }
        if (channel === 'install') {
          els.log.classList.remove('dpb-hidden');
          els.log.textContent += (payload.line || '') + (payload.done ? `\n== ${payload.ok ? 'done' : 'FAILED: ' + (payload.error || '')} ==` : '');
          els.log.scrollTop = els.log.scrollHeight;
          if (payload.done) { els.npm.disabled = false; els.npm.textContent = t('一键安装 dsh-pet（npm）', 'Install dsh-pet via npm'); }
        }
      });

      /* --- boot ----------------------------------------------------------------- */

      els.installTitle.textContent = t('安装桌宠本体（约 90MB，素材随包）', 'Install the pet itself (~90MB incl. assets)');
      els.driveTitle.textContent = t('和它互动', 'Interact');

      (async () => {
        await refreshStatus();
        if (st && st.running) await loadAnims();
      })();

      return { unmount() { offStatus && offStatus(); } };
    },
  });
})();
