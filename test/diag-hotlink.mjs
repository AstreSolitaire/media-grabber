// 针对性诊断：受防盗链保护的流为什么没被处理。
// 直接对比「脚本管理器的请求」和「页面身份的请求」，并列出面板里哪条缺体积。

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ensureFixtures, FIXTURES } from './make-fixtures.mjs';
import { startServer } from './static-server.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'userscript', 'media-grabber.user.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (u) =>
  new Promise((res, rej) =>
    http
      .get(u, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => {
          try {
            res(JSON.parse(b));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on('error', rej)
  );

const GM_SHIM = `
(function () {
  window.unsafeWindow = window;
  window.__mgShim = true;
  window.GM_xmlhttpRequest = function (opts) {
    var o = opts || {};
    fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, credentials: 'include', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.arrayBuffer().then(function (buf) { var h=[]; try { r.headers.forEach(function(v,k){ h.push(k+': '+v); }); } catch(e){} if (o.onload) o.onload({ status: r.status, statusText: r.statusText, finalUrl: r.url, responseHeaders: h.join(String.fromCharCode(13)+String.fromCharCode(10)), response: buf }); }); })
      .catch(function (e) { if (o.onerror) o.onerror(e); });
  };
  window.GM_download = function (o) { if (o.onerror) o.onerror({ error: 'shim 不支持' }); };
  var store = {};
  window.GM_setValue = function (k, v) { store[k] = v; };
  window.GM_getValue = function (k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; };
})();
`;

async function main() {
  const bin = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((c) =>
    existsSync(c)
  );
  const script = await readFile(SCRIPT, 'utf8');
  await ensureFixtures();
  const server = await startServer(FIXTURES);
  const profile = await mkdtemp(path.join(tmpdir(), 'mg-diag-'));
  await mkdir(path.join(profile, 'Default'), { recursive: true });
  const port = 9700 + Math.floor(Math.random() * 200);

  const child = spawn(
    bin,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--headless=new', 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stderr.on('data', () => {});

  let ver = null;
  for (let i = 0; i < 25 && !ver; i++) {
    await sleep(1000);
    try {
      ver = await httpJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      /* 继续等 */
    }
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pend = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    } else if (m.method) events.push(m);
  });
  const send = (method, params, sessionId) => {
    const id = ++seq;
    const p = { id, method, params: params || {} };
    if (sessionId) p.sessionId = sessionId;
    ws.send(JSON.stringify(p));
    return new Promise((res) => {
      pend.set(id, res);
      setTimeout(() => {
        if (pend.has(id)) {
          pend.delete(id);
          res({ timeout: true });
        }
      }, 30000);
    });
  };

  await send('Target.setDiscoverTargets', { discover: true });
  const tg = await send('Target.getTargets');
  const pageT = tg.result.targetInfos.find((t) => t.type === 'page');
  const sid = (await send('Target.attachToTarget', { targetId: pageT.targetId, flatten: true })).result.sessionId;
  await send('Runtime.enable', {}, sid);
  await send('Page.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: GM_SHIM }, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: script }, sid);
  await send('Page.navigate', { url: server.base + 'userscript-smoke.html' }, sid);
  await sleep(9000);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 200);
    return r.result?.result?.value;
  };

  const prot = `${server.base}protected/index.m3u8`;
  console.log('受保护地址:', prot.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
  console.log('\n--- 两种请求方式的对比 ---');
  console.log('无 Referer（脚本管理器那样）:', await ev(`fetch(${JSON.stringify(prot)}, {referrerPolicy:'no-referrer'}).then(function(r){return r.status})`));
  console.log('页面身份（带 referrer）    :', await ev(`fetch(${JSON.stringify(prot)}, {referrer: location.href, referrerPolicy:'unsafe-url', credentials:'include'}).then(function(r){return r.status})`));
  console.log('只加 credentials           :', await ev(`fetch(${JSON.stringify(prot)}, {credentials:'include'}).then(function(r){return r.status})`));

  console.log('\n--- 面板里各条的状态 ---');
  console.log(
    await ev(`(function(){
      var sr = document.querySelector('#mg-host').shadowRoot;
      return [].map.call(sr.querySelectorAll('.mg-item'), function(r){
        var n = r.querySelector('.mg-name'), m = r.querySelector('.mg-meta'), s = r.querySelector('.mg-size');
        var v = r.querySelector('.mg-variants');
        return (n?n.textContent:'') + '\\n    体积=' + (s?s.textContent:'(无)') + ' | meta=' + (m?m.textContent:'') + (v ? ' | 展开区=' + v.textContent.slice(0,60) : '');
      }).join('\\n');
    })()`)
  );

  console.log('\n--- 页面日志 ---');
  const logs = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    .filter(Boolean);
  console.log(logs.length ? logs.slice(-10).join('\n') : '(无)');
  console.log('\n--- 页面异常 ---');
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description || '');
  console.log(errs.length ? errs.slice(0, 5).join('\n') : '(无)');

  ws.close();
  child.kill();
  await sleep(300);
  await server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => {
  console.error('诊断失败：' + (e.stack || e.message));
  process.exit(1);
});
