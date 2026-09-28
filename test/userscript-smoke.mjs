// 用户脚本版的端到端验证：在真实浏览器里注入 GM 垫片 + 用户脚本，
// 走完「嗅探 → 面板 → 点下载 → 抓分片 → 转封装 → 落盘 → ffprobe」。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ensureFixtures, FIXTURES } from './make-fixtures.mjs';
import { startServer } from './static-server.mjs';
import { runPanelAssertions } from './panel-assertions.mjs';

const exec = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'userscript', 'media-grabber.user.js');

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/** Tampermonkey 的 GM_* 接口垫片，用来在没有 Tampermonkey 的环境里跑用户脚本 */
const GM_SHIM = `
(function () {
  window.unsafeWindow = window;
  window.__mgShim = true;
  window.GM_xmlhttpRequest = function (opts) {
    var o = opts || {};
    var ctl = new AbortController();
    var timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} if (o.ontimeout) o.ontimeout(); }, o.timeout || 60000);
    // 刻意不带 Referer，模拟真实的 GM_xmlhttpRequest：
    // 这正是防盗链 CDN 会拒绝脚本请求、而播放器能过的那点差别
    fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, credentials: 'include', referrerPolicy: 'no-referrer', signal: ctl.signal })
      .then(function (r) {
        return r.arrayBuffer().then(function (buf) {
          clearTimeout(timer);
          if (o.onload) o.onload({
            status: r.status,
            statusText: r.statusText,
            finalUrl: r.url,
            // 用 fromCharCode 拼 CRLF，避免在模板字符串里写转义
            responseHeaders: (function () {
              var a = [];
              try { r.headers.forEach(function (v, k) { a.push(k + ': ' + v); }); } catch (e) {}
              return a.join(String.fromCharCode(13) + String.fromCharCode(10));
            })(),
            response: o.responseType === 'arraybuffer' ? buf : undefined,
            responseText: o.responseType === 'text' ? new TextDecoder().decode(buf) : undefined
          });
        });
      })
      .catch(function (e) { clearTimeout(timer); if (o.onerror) o.onerror(e); });
  };
  window.GM_download = function (o) {
    var opts = o || {};
    fetch(opts.url, { credentials: 'include' })
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        var u = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = u; a.download = opts.name || 'download';
        document.documentElement.appendChild(a); a.click();
        window.__mgDownloaded = (window.__mgDownloaded || []).concat([opts.name]);
        if (opts.onload) opts.onload();
      })
      .catch(function (e) { if (opts.onerror) opts.onerror({ error: String(e) }); });
  };
  var store = {};
  window.GM_setValue = function (k, v) { store[k] = v; };
  window.GM_getValue = function (k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; };
})();
`;

// 注意：脚本用「页面内联」的方式加载，而不是 CDP 的 addScriptToEvaluateOnNewDocument。
// 后者创建的上下文没有 referrer 来源，会让「页面身份重发」在测试里永远失败——
// 这个盲点之前误导过好几次排查。内联脚本就是真正的文档上下文，行为和篡改猴一致。
const PAGE = (shim, script) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>用户脚本测试页</title>
<script>${shim.replace(/<\/script/gi, '<\/script')}</script>
<script>${script.replace(/<\/script/gi, '<\/script')}</script>
</head>
<body>
<h1>userscript smoke</h1>
<img src="img/photo.png" width="220" alt="photo">
<img src="img/banner.jpg" width="220" alt="banner">
<img src="img/tiny-icon.png" width="8" alt="tiny">
<video id="pv" src="clip.mp4" controls muted width="220"></video>
<script>
  fetch('ts/index.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__ts = t.length; });
  fetch('audio.mp3').then(function(r){ return r.blob(); }).then(function(b){ window.__mp3 = b.size; });
  fetch('fmp4/index.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__fmp4 = t.length; });
  // 由「页面自己的脚本」发起的、显式带 referrer 的请求。
  // 用它来判断：页面身份请求到底能不能通过 Referer 校验（排除 CDP 注入上下文没有 referrer 的干扰）
  setTimeout(function () {
    fetch('protected/index.m3u8', { referrer: location.href, referrerPolicy: 'unsafe-url', credentials: 'include' })
      .then(function (r) { window.__refFromPage = r.status; })
      .catch(function (e) { window.__refFromPage = 'ERR ' + e.message; });
  }, 300);
  // 模仿 PH 行为：播放列表能取，分片缺 Referer 就回 404
  fetch('phstyle/index-v1-a1.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__ph = t.length; });
  // 分片名伪装成 .mp4 的普通流：用来验证分片会被折叠，而不是混在列表里
  fetch('mp4named/index.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__mp4named = t.length; });
  fetch('mp4named/real/seg1-v1-a1.mp4').then(function(r){ return r.arrayBuffer(); }).then(function(b){ window.__mp4nameSeg = b.byteLength; });
  // 这条会被服务端按 Referer 校验：只有页面身份/播放器那种请求才拿得到
  fetch('protected/index.m3u8').then(function(r){ return r.text(); }).then(function(t){ window.__prot = t.length; });
  // 播放器也会去取分片；这里模拟一下，好验证分片会被折叠而不是混在列表里
  fetch('protected/seg1-v1-a1.mp4').then(function(r){ return r.arrayBuffer(); }).then(function(b){ window.__protSeg = b.byteLength; });
  var x = new XMLHttpRequest(); x.open('GET', 'aes/index.m3u8');
  x.onload = function(){ window.__aes = x.responseText.length; }; x.send();
</script>
</body></html>
`;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.sessionEvents = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
        return;
      }
      if (m.method && m.sessionId && this.sessionEvents.has(m.sessionId)) this.sessionEvents.get(m.sessionId).push(m);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
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
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const events = [];
    this.sessionEvents.set(sessionId, events);
    return { sessionId, events, send: (m, p) => this.raw(m, p, sessionId), eval: async (expr) => {
      const r = await this.raw('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error('页面内出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    } };
  }
  async findTarget(pred, timeout = 20000) {
    const deadline = Date.now() + timeout;
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
  throw new Error(`等待「${label}」超时${lastErr ? '：' + lastErr.message : ''}`);
}

async function main() {
  console.log('== 用户脚本端到端测试 ==');
  const bin = CANDIDATES.find((c) => existsSync(c));
  if (!bin) {
    console.log('没找到浏览器，跳过。');
    return;
  }
  const script = await readFile(SCRIPT, 'utf8');
  await ensureFixtures();
  await writeFile(path.join(FIXTURES, 'userscript-smoke.html'), PAGE(GM_SHIM, script), 'utf8');
  const server = await startServer(FIXTURES);

  const profile = await mkdtemp(path.join(tmpdir(), 'mg-us-'));
  const downloadDir = path.join(profile, 'downloads');
  await mkdir(downloadDir, { recursive: true });
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

  const port = 9500 + Math.floor(Math.random() * 400);
  const child = spawn(bin, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=420,820',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`  [${ok ? '通过' : '失败'}] ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures.push(name + (detail ? '：' + detail : ''));
  };

  let cdp = null;
  try {
    const ver = await waitFor(async () => {
      try {
        return await httpJson(`http://127.0.0.1:${port}/json/version`);
      } catch {
        return null;
      }
    }, { timeout: 25000, label: '调试端口就绪' });
    cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    const pageTarget = await cdp.findTarget((t) => t.type === 'page', 15000);
    if (!pageTarget) throw new Error('没有页面标签');
    const page = await cdp.attach(pageTarget.targetId);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: server.base + 'userscript-smoke.html' });

    const state = await waitFor(async () => {
      const v = await page.eval('JSON.stringify({ts: window.__ts, mp3: window.__mp3, fmp4: window.__fmp4, aes: window.__aes, prot: window.__prot, ph: window.__ph})');
      const o = JSON.parse(v || '{}');
      return o.ts && o.mp3 && o.fmp4 && o.aes && o.prot ? o : null;
    }, { timeout: 25000, label: '测试页请求完成' });
    check('测试页加载完成并请求了媒体', true, JSON.stringify(state));
    check('用户脚本已注入（GM 垫片生效）', (await page.eval('window.__mgShim === true')) === true);

    const panel = await waitFor(async () => {
      const v = await page.eval(`(function(){
        var host = document.querySelector('#mg-host');
        if (!host || !host.shadowRoot) return null;
        var rows = host.shadowRoot.querySelectorAll('.mg-item');
        if (!rows.length) return null;
        return JSON.stringify({ n: rows.length, names: [].map.call(rows, function(r){
          var a = r.querySelector('.mg-name'); return a ? a.textContent : '';
        }), urls: [].map.call(rows, function(r){
          var a = r.querySelector('.mg-meta'); return a ? (a.getAttribute('title')||'') : '';
        })});
      })()`);
      return JSON.parse(v || 'null');
    }, { timeout: 25000, label: '面板出现' }).catch(async (e) => {
      // 面板没出来时，把页面里的真实报错打出来，别只留一个超时
      console.log('  —— 诊断 ——');
      console.log('  window.MGUI:', await page.eval('typeof window.MGUI'));
      console.log('  MGUI 导出:', await page.eval('window.MGUI ? Object.keys(window.MGUI).join(",") : "-"'));
      console.log('  #mg-host:', await page.eval('!!document.querySelector("#mg-host")'));
      console.log('  CSS 常量:', await page.eval('typeof CSS'));
      const errs = page.events
        .filter((ev) => ev.method === 'Runtime.exceptionThrown' || (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error'))
        .map((ev) => ev.params.exceptionDetails?.exception?.description || ev.params.entry?.text || '');
      console.log('  页面报错:', errs.length ? '\n            ' + errs.slice(0, 5).join('\n            ') : '(无)');
      const logs = page.events
        .filter((ev) => ev.method === 'Runtime.consoleAPICalled')
        .map((ev) => (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      console.log('  页面日志:', logs.length ? '\n            ' + logs.slice(0, 8).join('\n            ') : '(无)');
      throw e;
    });
    check('面板已挂载并列出条目', panel.n >= 3, `${panel.n} 行：${panel.names.join(' | ')}`);
    check('列表里是 m3u8/音频而不是 .ts 分片', panel.urls.some((u) => u.endsWith('.m3u8')) && !panel.urls.some((u) => /\/seg\d+\.ts$/.test(u)));
    check('文件名用了页面标题', panel.names.some((n) => n.includes('用户脚本测试页')), panel.names.join(' | '));

    // ---- 新增：体积显示、图片分页、缩略图与全屏预览 ----
    await runPanelAssertions({ page, check, sleep, waitFor });

    // 点 m3u8 的按钮 → 选最高码率 → 下载
    const clicked = await page.eval(`(function(){
      var host = document.querySelector('#mg-host');
      var rows = host.shadowRoot.querySelectorAll('.mg-item');
      for (var i = 0; i < rows.length; i++) {
        var meta = rows[i].querySelector('.mg-meta');
        var t = meta && meta.getAttribute('title');
        if (t && t.indexOf('/phstyle/index-v1-a1.m3u8') >= 0) {
          var bs = rows[i].querySelectorAll('.mg-btn');
          for (var j = 0; j < bs.length; j++) {
            if (bs[j].textContent === '清晰度') { bs[j].click(); return 'clicked:清晰度'; }
          }
          return 'no-quality-button';
        }
      }
      return 'not-found';
    })()`);
    check('能点到 m3u8 条目', String(clicked).startsWith('clicked'), String(clicked));

    await sleep(1500);
    const best = await page.eval(`(function(){
      var host = document.querySelector('#mg-host');
      var bs = host.shadowRoot.querySelectorAll('.mg-variants .mg-btn');
      for (var i = 0; i < bs.length; i++) {
        if (/下载|最高码率/.test(bs[i].textContent)) { bs[i].click(); return 'ok'; }
      }
      return 'no-button:' + bs.length;
    })()`);
    check('进入下载流程', best === 'ok', String(best));

    const files = await waitFor(async () => {
      const out = [];
      async function scan(d, prefix = '') {
        let entries = [];
        try {
          entries = await readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await scan(p, prefix + e.name + '/');
          else if (!e.name.endsWith('.crdownload')) out.push({ rel: prefix + e.name, abs: p, size: (await stat(p)).size });
        }
      }
      await scan(downloadDir);
      const media = out.filter((f) => /\.(mp4|m4a|ts|mp3|aac)$/i.test(f.rel));
      return media.length ? media : null;
    }, { timeout: 120000, interval: 1000, label: '文件落盘' });

    check('文件已保存', files.length > 0, files.map((f) => `${f.rel}(${f.size}B)`).join(', '));


    // 受防盗链保护的那条：点击下载后应给出可操作的提示，而不是干巴巴的 HTTP 410
    const blockedMsg = await (async () => {
      const clickedBlocked = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        sr.querySelectorAll('.mg-tab')[0].click();
        var rows = sr.querySelectorAll('.mg-item');
        for (var i = 0; i < rows.length; i++) {
          var m = rows[i].querySelector('.mg-meta');
          if ((m.getAttribute('title') || '').indexOf('/protected/index.m3u8') >= 0) {
            var bs = rows[i].querySelectorAll('.mg-btn');
            for (var j = 0; j < bs.length; j++) {
              if (bs[j].textContent === '清晰度') { bs[j].click(); return 'ok'; }
            }
          }
        }
        return 'not-found';
      })()`);
      if (clickedBlocked !== 'ok') return '点击失败：' + clickedBlocked;
      await sleep(1200);
      const ran = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        var rows = sr.querySelectorAll('.mg-item');
        for (var i = 0; i < rows.length; i++) {
          var m = rows[i].querySelector('.mg-meta');
          if ((m.getAttribute('title') || '').indexOf('/protected/index.m3u8') >= 0) {
            var bs = rows[i].querySelectorAll('.mg-btn');
            for (var j = 0; j < bs.length; j++) {
              if (bs[j].textContent.indexOf('下载') >= 0) { bs[j].click(); return 'ok'; }
            }
          }
        }
        return 'no-download-button';
      })()`);
      if (ran !== 'ok') return '未点到下载：' + ran;
      for (let i = 0; i < 30; i++) {
        await sleep(400);
        // 只看最新那条任务，别读到上一个任务的完成消息
        const text = await page.eval(`(function(){
          var sr = document.querySelector('#mg-host').shadowRoot;
          var j = sr.querySelector('.mg-jobs .mg-job');
          return j ? j.textContent : '';
        })()`);
        if (text && /失败|完成/.test(text)) return text;
      }
      return '(没有等到结果)';
    })();
    check(
      '受防盗链保护时给出可操作的提示（而不是干巴巴的 HTTP 410）',
      /防盗链|刷新/.test(blockedMsg) && !/^HTTP 410$/.test(blockedMsg),
      blockedMsg.slice(0, 120)
    );

    // 误列出来的分片应该被折叠到「显示疑似分片」里
    const fold = JSON.parse(
      await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        var rows = sr.querySelectorAll('.mg-item');
        var visible = [].map.call(rows, function(r){
          var m = r.querySelector('.mg-meta'); return m ? (m.getAttribute('title')||'') : '';
        });
        var btn = sr.querySelector('.mg-show-all');
        return JSON.stringify({
          visible: visible,
          showAll: btn && !btn.hidden ? btn.textContent : ''
        });
      })()`)
    );
    check(
      '伪装成 .mp4 的分片没有混在列表里，被折叠起来了',
      !fold.visible.some((u) => u.includes('/mp4named/real/seg')) && /显示疑似分片/.test(fold.showAll),
      `可见 ${fold.visible.length} 条：${fold.visible.map((u) => u.split('/').slice(-2).join('/')).join(' | ')}；折叠按钮「${fold.showAll}」`
    );
    const mp4 = files.find((f) => f.rel.endsWith('.mp4'));
    if (mp4) {
      const { stdout } = await exec('ffprobe', ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4.abs]);
      const info = JSON.parse(stdout);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      check('MP4 可被 ffprobe 解析', !!v, v ? `${v.codec_name} ${v.width}x${v.height} + ${a ? a.codec_name : '无音频'}` : '无视频流');
      check('时长与播放列表声明一致（2 段 × 2 秒）', Math.abs(Number(info.format.duration) - 4) < 0.6, `时长 ${info.format.duration}`);
      const probe = await exec('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', mp4.abs, '-f', 'null', '-']).catch((e) => ({ stderr: e.stderr || '' }));
      const bad = String(probe.stderr || '').split('\n').filter((l) => /non-monotonic|Invalid|corrupt|Error/i.test(l));
      check('完整解码无报错', bad.length === 0, bad.slice(0, 2).join(' / ') || '干净');
    } else {
      check('下载的是 MP4', false, '实际：' + files.map((f) => f.rel).join(', '));
    }

    const errs = page.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails?.exception?.description || '')
      .filter(Boolean);
    check('页面里没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' / '));
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
    process.exit(1);
  }
  console.log('全部通过。');
}

main().catch((e) => {
  console.error('测试出错：' + (e.stack || e.message));
  process.exit(1);
});
