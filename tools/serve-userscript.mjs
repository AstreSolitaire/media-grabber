// 一个只监听本机的小服务，用来把用户脚本交给手机安装。
// 配合 `adb reverse tcp:8899 tcp:8899`，手机访问 http://localhost:8899 就能拿到，
// 全程走 USB，不需要手机和电脑连同一个 Wi-Fi，也不对外网暴露任何东西。

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { handleProtected, handleMp4Named } from  '../test/protected-route.mjs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.MG_SERVE_PORT || 8899);

const FILES = {
  '/media-grabber.user.js': {
    file: path.join(ROOT, 'userscript', 'media-grabber.user.js'),
    type: 'text/javascript; charset=utf-8',
  },
  '/phone-test.html': {
    file: path.join(ROOT, 'test', 'phone-test.html'),
    type: 'text/html; charset=utf-8',
  },
  '/': {
    file: null,
    type: 'text/html; charset=utf-8',
  },
};

const FIXTURES = path.join(ROOT, 'test', 'tmp', 'fixtures');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.key': 'application/octet-stream',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // 把请求头打出来：用来搞清楚用户脚本发出的请求到底带了什么（Referer / Origin / Cookie）
  const via = ((req.headers['x-mg-via'] ) || '').toString();
  console.log(
    `[请求] ${req.method} ${url.pathname}${url.search}` +
      ` | Referer=${req.headers.referer || '(无)'}` +
      ` | Origin=${req.headers.origin || '(无)'}` +
      ` | Cookie=${req.headers.cookie ? '有' : '(无)'}` +
      ` | UA=${(req.headers['user-agent'] || '').slice(0, 40)}`
  );
  // 把测试素材也发出去，方便在手机上跑真实测试
  // 手机侧走 /f/protected/，复用与端到端测试同一份防盗链模拟
  if (await handleProtected(req, res, url.pathname, FIXTURES, '/f/protected/')) return;
  if (await handleMp4Named(req, res, url.pathname, FIXTURES, '/f/mp4named/')) return;

  if (url.pathname.startsWith('/f/')) {
    const rel = decodeURIComponent(url.pathname.slice(3));
    // 测试页放在仓库里（不在生成的素材目录），但要让它的相对路径仍落在 /f/ 下，
    // 页面里的 img/xxx、clip.mp4 才能取到素材
    const inRepo = rel === 'phone-test.html' || rel === 'phone-hotlink.html';
    const file = inRepo ? path.join(ROOT, 'test', rel) : path.join(FIXTURES, rel);
    const allowed = file.startsWith(FIXTURES) || file.startsWith(path.join(ROOT, 'test'));
    if (!allowed) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const buf = await readFile(file);
      res
        .writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': buf.length })
        .end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
    return;
  }
  const entry = FILES[url.pathname];
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  if (!entry.file) {
    res
      .writeHead(200, { 'content-type': entry.type })
      .end(
        '<!doctype html><meta charset="utf-8"><title>媒体嗅探下载器 · 用户脚本</title>' +
          '<body style="font:16px/1.7 -apple-system,system-ui,sans-serif;padding:24px">' +
          '<h2>用户脚本已就绪</h2>' +
          '<p>在手机 Edge 里打开下面这个地址，篡改猴会弹出安装页面：</p>' +
          '<p><a href="/media-grabber.user.js">/media-grabber.user.js</a></p>' +
          '<p>装好后可以用这条测试流试手：<a href="/f/phone-test.html">/f/phone-test.html</a></p>' +
          '<p style="color:#666">这个服务只监听电脑本机，通过 USB 转发给手机，不对外网开放。</p>'
      );
    return;
  }
  try {
    const buf = await readFile(entry.file);
    res.writeHead(200, { 'content-type': entry.type, 'content-length': buf.length }).end(buf);
    console.log(`  ← 已把用户脚本发给 ${req.socket.remoteAddress}`);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('读取失败：' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`用户脚本服务已启动：http://localhost:${PORT}/media-grabber.user.js`);
  console.log('（只监听 127.0.0.1，配合 adb reverse 给手机用）');
});
