// 端到端冒烟测试：真的启动一个 Chromium 内核浏览器加载本扩展，走完整条链路：
//   页面请求 m3u8 → 嗅探 → 面板出现 → 点下载 → saver 抓取并转封装 → 文件落盘。
// 这一步能验证静态检查覆盖不到的东西：manifest 能否被接受、SW 能否启动、
// 主世界钩子与内容脚本能否注入、消息链路是否通、blob 下载能否落盘。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ensureFixtures, FIXTURES } from './make-fixtures.mjs';
import { startServer } from './static-server.mjs';
import { runPanelAssertions } from './panel-assertions.mjs';

const exec = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');

// 注意：Chrome 已从正式版里移除 --load-extension（实测 156 会静默忽略），
// Edge 目前仍然支持，所以优先用 Edge 跑。这也正好是我们要验证的目标浏览器。
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

/** 扩展的 Service Worker 起来后，页面里应该能观察到主世界钩子。用这个判断扩展是否真的加载。 */
function browsersToTry() {
  const found = CANDIDATES.filter((c) => existsSync(c));
  // 品牌版 Chrome 会忽略 --load-extension，放到最后再试
  return found.sort((a, b) => (/chrome\.exe$/i.test(a) ? 1 : 0) - (/chrome\.exe$/i.test(b) ? 1 : 0));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/** 用 flatten 会话的 CDP 客户端。比走 /json/list 稳得多。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.sessionEvents = new Map();
    this.globalEvents = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        if (msg.sessionId && this.sessionEvents.has(msg.sessionId)) {
          this.sessionEvents.get(msg.sessionId).push(msg);
        } else {
          this.globalEvents.push(msg);
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  raw(method, params, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 30000);
    });
  }

  send(method, params) {
    return this.raw(method, params, null);
  }

  async attach(targetId) {
    const res = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = res.sessionId;
    const events = [];
    this.sessionEvents.set(sessionId, events);
    return new Session(this, sessionId, events);
  }

  async findTarget(pred, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send('Target.getTargets');
      const hit = targetInfos.find(pred);
      if (hit) return hit;
      await sleep(300);
    }
    return null;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

class Session {
  constructor(cdp, sessionId, events) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.events = events;
  }
  send(method, params) {
    return this.cdp.raw(method, params, this.sessionId);
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error('页面内执行出错：' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  }
  errors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => {
        const url = e.params.entry?.url || '';
        const text = e.params.exceptionDetails?.exception?.description || e.params.entry?.text || '';
        return { url, text };
      })
      .filter((x) => x.text && !/favicon/i.test(x.url) && !/favicon/i.test(x.text))
      .map((x) => x.text + (x.url ? ` [${x.url}]` : ''));
  }
  consoleLogs() {
    return this.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled')
      .map((e) => (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
}

async function waitFor(fn, { timeout = 30000, interval = 400, label = '条件' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`等待「${label}」超时${lastErr ? '，最后一次错误：' + lastErr.message : ''}`);
}

// ---------------------------------------------------------------- 测试页面

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>HLS 测试页</title></head>
<body>
<h1>media sniff smoke test</h1>
<video id="v" controls width="320"></video>
<img src="img/photo.png" width="220" alt="photo">
<img src="img/banner.jpg" width="220" alt="banner">
<img src="img/tiny-icon.png" width="8" alt="tiny">
<video id="pv" src="clip.mp4" controls muted width="220"></video>
<a href="/ts/index.m3u8">m3u8</a>
<script>
  // 分别用 fetch / XHR 取播放列表，主世界钩子两条路径都要能抓到
  fetch('fmp4/index.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__fmp4 = t.length; });
  fetch('ts/index.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__ts = t.length; document.getElementById('v').dataset.hls='ok'; });
  var x = new XMLHttpRequest();
  x.open('GET', 'aes/index.m3u8');
  x.onload = function(){ window.__aes = x.responseText.length; };
  x.send();
  fetch('audio.mp3').then(function(r){ return r.blob(); }).then(function(b){ window.__mp3 = b.size; });
  fetch('master/master.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__master = t.length; });
</script>
</body></html>
`;

async function main() {
  console.log('== 端到端冒烟测试 ==');
  const bin = browsersToTry()[0];
  if (!bin) {
    console.log('没找到 Chromium 内核浏览器，跳过（不算失败）。');
    return;
  }
  console.log('浏览器：' + bin);

  await ensureFixtures();
  await writeFile(path.join(FIXTURES, 'smoke.html'), PAGE, 'utf8');
  const server = await startServer(FIXTURES);

  const profile = await mkdtemp(path.join(tmpdir(), 'mg-smoke-'));
  const downloadDir = path.join(profile, 'downloads');
  await mkdir(downloadDir, { recursive: true });

  // 默认跑有头模式：CDP 的 Browser.setDownloadBehavior 会改写文件名（把建议名换成
  // 由 URL 派生的名字），这样就没法验证「我们给的文件名是否被采纳」。改用配置文件指定
  // 下载目录，完全绕开 CDP，贴近真实用户环境。想跑得更快可以设 MG_HEADLESS=1。
  const headless = process.env.MG_HEADLESS === '1';
  if (!headless) {
    await mkdir(path.join(profile, 'Default'), { recursive: true });
    await writeFile(
      path.join(profile, 'Default', 'Preferences'),
      JSON.stringify({
        download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
        savefile: { default_directory: downloadDir },
        profile: { default_content_setting_values: { automatic_downloads: 1 } },
      }),
      'utf8'
    );
  }

  const debugPort = 9333 + Math.floor(Math.random() * 500);

  const child = spawn(
    bin,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXT}`,
      `--disable-extensions-except=${EXT}`,
      `--remote-debugging-port=${debugPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(headless ? ['--headless=new'] : ['--window-size=420,820']),
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  console.log('运行模式：' + (headless ? 'headless（不校验文件名）' : '有头（会短暂弹出浏览器窗口）'));
  let browserLog = '';
  child.stderr.on('data', (d) => (browserLog += d.toString()));

  let cdp = null;
  let page = null;
  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`  [${ok ? '通过' : '失败'}] ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures.push(name + (detail ? '：' + detail : ''));
  };

  try {
    const version = await waitFor(
      async () => {
        try {
          return await httpJson(`http://127.0.0.1:${debugPort}/json/version`);
        } catch {
          return null;
        }
      },
      { timeout: 25000, label: '浏览器调试端口就绪' }
    );
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    if (headless) {
      // headless 下默认禁止下载，必须显式允许（但随之会失去文件名校验能力）
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
    }

    // 1) 扩展自己起来了吗。注意不能只看「有没有 service_worker」：
    //    浏览器自带组件扩展也有 worker，必须认我们自己的脚本文件名。
    const sw = await waitFor(
      async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return (
          targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith('/src/background.js')) || null
        );
      },
      { timeout: 20000, interval: 500, label: '扩展的 Service Worker 出现' }
    );
    console.log('扩展已加载：' + sw.url);
    check('扩展能被浏览器加载、后台 Service Worker 正常启动', true);

    // 顺手把 SW 的控制台也接上，方便发现后台异常（拿不到也不影响结论）
    let swSession = null;
    try {
      swSession = await cdp.attach(sw.targetId);
      await swSession.send('Runtime.enable');
      await swSession.send('Log.enable');
    } catch {
      swSession = null;
    }

    // 2) 打开测试页
    const pageTarget = await cdp.findTarget((t) => t.type === 'page', 10000);
    if (!pageTarget) throw new Error('没有可用的页面标签');
    page = await cdp.attach(pageTarget.targetId);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: server.base + 'smoke.html' });

    const pageState = await waitFor(
      async () => {
        const v = await page.eval(
          'JSON.stringify({ts: window.__ts, fmp4: window.__fmp4, aes: window.__aes, mp3: window.__mp3, master: window.__master})'
        );
        const o = JSON.parse(v || '{}');
        return o.ts && o.fmp4 && o.aes && o.mp3 && o.master ? o : null;
      },
      { timeout: 25000, label: '测试页里的媒体请求完成' }
    );
    check('测试页加载完成并请求了各类媒体', true, JSON.stringify(pageState));

    // 3) 主世界钩子
    const hooked = await page.eval('window.__mgSnifferInstalled === true');
    check('主世界嗅探脚本已注入（fetch/XHR 钩子生效）', hooked === true);

    // 4) 面板：说明 主世界 → 内容脚本 → 后台 → 回推 UI 整条链路都通了
    const panel = await waitFor(
      async () => {
        const v = await page.eval(`(function(){
          var host = document.querySelector('#mg-host');
          if (!host || !host.shadowRoot) return null;
          var rows = host.shadowRoot.querySelectorAll('.mg-item');
          if (!rows.length) return null;
          return JSON.stringify({ rows: rows.length, names: [].map.call(rows, function(r){
            var n = r.querySelector('.mg-name'); return n ? n.textContent : '';
          }), urls: [].map.call(rows, function(r){
            var m = r.querySelector('.mg-meta'); return m ? (m.getAttribute('title')||'') : '';
          }) });
        })()`);
        return JSON.parse(v || 'null');
      },
      { timeout: 25000, label: '页面内面板出现并列出条目' }
    ).catch(async (e) => {
      console.log('  —— 诊断 ——');
      console.log('  window.MGUI:', await page.eval('typeof window.MGUI'));
      console.log('  #mg-host:', await page.eval('!!document.querySelector("#mg-host")'));
      const errs = page.events
        .filter((ev) => ev.method === 'Runtime.exceptionThrown' || (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error'))
        .map((ev) => ev.params.exceptionDetails?.exception?.description || ev.params.entry?.text || '');
      const NL = String.fromCharCode(10) + '            ';
      console.log('  页面报错:', errs.length ? NL + errs.slice(0, 5).join(NL) : '(无)');
      if (swSession) {
        const tabs = await swSession
          .eval('chrome.storage.session.get("mgTabs").then(function(o){ return JSON.stringify(Object.keys(o.mgTabs||{}).map(function(k){ return k + ":" + (o.mgTabs[k]||[]).length; })); })')
          .catch((err) => '读取失败 ' + err.message);
        console.log('  后台记录的条目:', tabs);
        const swErr = swSession.errors();
        console.log('  后台报错:', swErr.length ? NL + swErr.slice(0, 5).join(NL) : '(无)');
      }
      const logs = page.events
        .filter((ev) => ev.method === 'Runtime.consoleAPICalled')
        .map((ev) => (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      console.log('  页面日志:', logs.length ? NL + logs.slice(0, 8).join(NL) : '(无)');
      throw e;
    });
    check('页面内悬浮面板已挂载并列出条目', panel.rows >= 3, `${panel.rows} 行：${panel.names.join(' | ')}`);
    check('列表里是 m3u8 / 音频，而不是 .ts 分片', panel.urls.some((u) => u.endsWith('index.m3u8')) && !panel.urls.some((u) => /\/seg\d+\.ts$/.test(u)));
    check('文件名用了页面标题，不是光秃秃的 index.m3u8', panel.names.some((n) => n.includes('HLS 测试页')), panel.names.join(' | '));

    // ---- 体积显示、图片分页与预览（与用户脚本共用同一套界面）----
    await runPanelAssertions({ page, check, sleep, waitFor, swSession });

    // 5) 点 m3u8 的下载按钮，走完 抓取 → 转封装 → 落盘
    const clicked = await page.eval(`(function(){
      var host = document.querySelector('#mg-host');
      var rows = host.shadowRoot.querySelectorAll('.mg-item');
      for (var i = 0; i < rows.length; i++) {
        var meta = rows[i].querySelector('.mg-meta');
        var title = meta && meta.getAttribute('title');
        if (title && title.indexOf('/ts/index.m3u8') >= 0) {
          var bs = rows[i].querySelectorAll('.mg-btn');
          for (var j = 0; j < bs.length; j++) {
            if (bs[j].textContent === '清晰度') { bs[j].click(); return 'clicked:清晰度'; }
          }
          return 'no-quality-button';
        }
      }
      return 'not-found';
    })()`);
    check('能点到 m3u8 条目的下载按钮', String(clicked).startsWith('clicked'), String(clicked));

    await sleep(1500);
    const best = await page.eval(`(function(){
      var host = document.querySelector('#mg-host');
      var btns = host.shadowRoot.querySelectorAll('.mg-variants .mg-btn');
      for (var i = 0; i < btns.length; i++) {
        // 多码率给的是「最高码率直接下」，单码率列表直接给「下载（约 X）」
        if (/下载|最高码率/.test(btns[i].textContent)) { btns[i].click(); return 'ok'; }
      }
      var all = host.shadowRoot.querySelectorAll('.mg-variants .mg-btn');
      var texts = [].map.call(all, function(x){ return x.textContent; });
      return 'no-variants:' + all.length + ' [' + texts.join(' | ') + ']';
    })()`);
    check('点击后进入下载流程', best === 'ok', String(best));

    // 6) 等文件落盘
    const files = await waitFor(
      async () => {
        const out = [];
        async function scan(dir, prefix = '') {
          let entries = [];
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) await scan(p, prefix + e.name + '/');
            else if (!e.name.endsWith('.crdownload')) out.push({ rel: prefix + e.name, abs: p, size: (await stat(p)).size });
          }
        }
        await scan(downloadDir);
        const media = out.filter((f) => /\.(mp4|m4a|ts|mp3|aac)$/i.test(f.rel));
        return media.length ? media : null;
      },
      { timeout: 120000, interval: 1000, label: '下载文件落盘' }
    );

    check('文件已保存到下载目录', files.length > 0, files.map((f) => `${f.rel}(${f.size}B)`).join(', '));

    // 顺便看一眼下载记录里登记的文件名，确认我们给的文件名确实被采纳
    if (swSession) {
      try {
        const rec = await swSession.eval(
          'chrome.downloads.search({limit:5, orderBy:["-startTime"]}).then(function(r){return JSON.stringify(r.map(function(d){return {f:d.filename.split(/[\\\\/]/).pop(), s:d.state, e:d.error&&d.error.current}}))})'
        );
        console.log('  下载记录：' + rec);
        const parsed = JSON.parse(rec || '[]').filter((d) => /\.(mp4|m4a|mp3|ts|aac)$/i.test(d.f || ''));
        if (headless) {
          console.log('  （headless 模式会被 CDP 改写文件名，跳过文件名校验）');
        } else {
          const guid = parsed.find((d) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(d.f || ''));
          check(
            '保存时用了我们建议的文件名（页面标题）',
            !guid && parsed.some((d) => (d.f || '').includes('HLS 测试页')),
            guid ? `实际文件名 ${guid.f}（说明 filename 被忽略了）` : parsed.map((d) => d.f).join(', ') || '无记录'
          );
        }
      } catch (e) {
        console.log('  （读取下载记录失败：' + e.message + '）');
      }
    }

    const mp4 = files.find((f) => f.rel.endsWith('.mp4'));
    if (mp4) {
      const { stdout } = await exec('ffprobe', ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4.abs]);
      const info = JSON.parse(stdout);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      const dur = Number(info.format.duration);
      check('下载的 MP4 能被 ffprobe 解析', !!v, v ? `${v.codec_name} ${v.width}x${v.height} + ${a ? a.codec_name : '无音频'}` : '没有视频流');
      check('MP4 时长接近源（6 秒）', Math.abs(dur - 6) < 0.6, `时长 ${dur}`);
      const probe = await exec('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', mp4.abs, '-f', 'null', '-']).catch((e) => ({ stderr: e.stderr || '' }));
      const bad = String(probe.stderr || '')
        .split('\n')
        .filter((l) => /non-monotonic|Invalid|corrupt|Error/i.test(l));
      check('下载的 MP4 完整解码无报错', bad.length === 0, bad.slice(0, 2).join(' / ') || '干净');
    } else {
      check('下载的是 MP4（而不是原始 .ts）', false, '实际文件：' + files.map((f) => f.rel).join(', '));
    }

    // 7) 有没有异常
    if (swSession) {
      const swErr = swSession.errors();
      check('后台没有抛异常', swErr.length === 0, swErr.slice(0, 2).join(' / '));
    }
    const pageErr = page.errors();
    check('页面里没有因扩展产生的未捕获异常', pageErr.length === 0, pageErr.slice(0, 2).join(' / '));

    // 8) 桌面版弹窗也要能正常渲染（它和面板共用一套 UI，但不能因此免检）
    const extId = new URL(sw.url).host;
    const popupTarget = await cdp.findTarget((t) => t.type === 'page', 5000);
    const popup = await cdp.attach(popupTarget.targetId);
    await popup.send('Runtime.enable');
    await popup.send('Page.enable');
    await popup.send('Page.navigate', { url: `chrome-extension://${extId}/src/popup.html` });
    const popupState = await waitFor(
      async () => {
        const v = await popup.eval(`JSON.stringify({
          root: !!document.querySelector('#app .mg-root'),
          panel: !!document.querySelector('#app .mg-panel'),
          fab: !!document.querySelector('#app .mg-fab'),
          empty: !!document.querySelector('#app .mg-empty'),
          settings: !!document.getElementById('folder') && !!document.getElementById('concurrency')
        })`);
        const o = JSON.parse(v || 'null');
        return o && o.root && o.settings ? o : null;
      },
      { timeout: 15000, label: '弹窗渲染完成' }
    );
    check(
      '桌面版弹窗能正常渲染（面板 + 设置项）',
      popupState.root && popupState.panel && popupState.settings && !popupState.fab,
      JSON.stringify(popupState)
    );
    const popupErr = popup.errors();
    check('弹窗里没有未捕获异常', popupErr.length === 0, popupErr.slice(0, 2).join(' / '));
  } finally {
    cdp?.close();
    child.kill();
    await sleep(400);
    await server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n== 结果 ==');
  if (failures.length) {
    console.log(`${failures.length} 项未通过：`);
    for (const f of failures) console.log('  - ' + f);
    if (browserLog) console.log('\n浏览器输出片段：\n' + browserLog.split('\n').filter(Boolean).slice(-20).join('\n'));
    process.exit(1);
  }
  console.log('全部通过。');
}

main().catch((e) => {
  console.error('\n冒烟测试出错：' + (e.stack || e.message));
  process.exit(1);
});
