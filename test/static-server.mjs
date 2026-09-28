// 极简静态文件服务器，支持 Range 请求（用来测 EXT-X-BYTERANGE 和 readBody 的裁剪逻辑）。

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { handleProtected, handleMp4Named, handlePhStyle } from  './protected-route.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.key': 'application/octet-stream',
  '.txt': 'text/plain',
};

export async function startServer(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (process.env.MG_DEBUG_REF === '1') {
        console.log(
          `[请求] ${req.method} ${url.pathname} | Referer=${req.headers.referer || '(无)'} | Origin=${
            req.headers.origin || '(无)'
          }`
        );
      }
      // 先看是不是「防盗链模拟」那组路径
      if (await handleProtected(req, res, url.pathname, root)) return;
      if (await handleMp4Named(req, res, url.pathname, root, '/mp4named/')) return;
      if (await handlePhStyle(req, res, url.pathname, root, '/phstyle/')) return;
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(root, rel);
      if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : info.size - 1;
          const buf = await readFile(file);
          const slice = buf.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': slice.length,
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Accept-Ranges': 'bytes',
          });
          res.end(slice);
          return;
        }
      }
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' });
      res.end(buf);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(r)),
  };
}
