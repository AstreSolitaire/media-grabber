// 模拟一个「防盗链 CDN」：校验 Referer，不通过就回 410 Gone。
// 端到端测试和手机用的本地服务都调用这里，避免各自实现一份。
//
// 用来复现真实站点的行为：页面（播放器）自己取是能过的，
// 而脚本管理器发出的、不带 Referer 的请求会被拒。

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const NL = String.fromCharCode(10);

/**
 * @param {string} rel 相对于挂载点的路径，例如 'index.m3u8' 或 'seg1-v1-a1.mp4'
 * @param {string} fixturesDir 素材目录（真实 TS 分片从这里取）
 * @returns {{status:number, type:string, body:Buffer|string}|null} null 表示不是这个前缀的请求
 */
export function protectedResponse(rel, fixturesDir) {
  if (rel === 'index.m3u8') {
    return {
      status: 200,
      type: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:0',
        // 分片文件名故意伪装成 .mp4 —— 真实站点就这么干，
        // 光看扩展名会把它们误当成独立视频列出来
        '#EXTINF:2.0,',
        'seg1-v1-a1.mp4',
        '#EXTINF:2.0,',
        'seg2-v1-a1.mp4',
        '#EXTINF:2.0,',
        'seg3-v1-a1.mp4',
        '#EXT-X-ENDLIST',
        '',
      ].join(NL),
    };
  }
  const m = /^seg([123])-v1-a1\.mp4$/.exec(rel);
  if (m) {
    // 内容是真实 TS 数据，保证后面能正常转封装
    return { status: 200, type: 'video/mp2t', file: path.join(fixturesDir, 'ts', `seg00${Number(m[1]) - 1}.ts`) };
  }
  return { status: 404, type: 'text/plain; charset=utf-8', body: 'protected: not found' };
}

/** 判断请求是否通过了 Referer 校验。 */
export function refererAllowed(req) {
  const ref = req.headers.referer || '';
  const ok = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(ref);
  if (process.env.MG_DEBUG_REF === '1') {
    console.log(`[防盗链] Referer=${ref || '(无)'} → ${ok ? '放行' : '410'}`);
  }
  return ok;
}

/** 供 http 服务器直接调用的写法：处理 /protected/ 前缀。 */
export async function handleProtected(req, res, pathname, fixturesDir, prefix = '/protected/') {
  if (!pathname.startsWith(prefix)) return false;
  const rel = decodeURIComponent(pathname.slice(prefix.length));

  if (!refererAllowed(req)) {
    res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('Gone（Referer 校验不通过）');
    return true;
  }

  const out = protectedResponse(rel, fixturesDir);
  if (!out) {
    res.writeHead(404).end('not found');
    return true;
  }
  if (out.file) {
    try {
      const buf = await readFile(out.file);
      res.writeHead(out.status, { 'content-type': out.type, 'content-length': buf.length }).end(buf);
    } catch {
      res.writeHead(404).end('no segment');
    }
    return true;
  }
  res.writeHead(out.status, { 'content-type': out.type }).end(out.body);
  return true;
}

/**
 * 另一组流：不做 Referer 校验，但分片名同样伪装成 .mp4。
 * 用来单独验证「分片被折叠」这个修复（不受防盗链判定的干扰）。
 */
export async function handleMp4Named(req, res, pathname, fixturesDir, prefix = '/mp4named/') {
  if (!pathname.startsWith(prefix)) return false;
  const rel = decodeURIComponent(pathname.slice(prefix.length));

  // 播放列表先 302 到子目录，分片是相对路径。
  // 这样能测出「相对路径是否以重定向后的地址为基准」——用请求前的地址会全部 404
  if (rel === 'index.m3u8') {
    res.writeHead(302, { location: `${prefix}real/index.m3u8` }).end();
    return true;
  }
  if (rel === 'real/index.m3u8') {
    res
      .writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      .end(
        ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:2.0,', 'seg1-v1-a1.mp4', '#EXTINF:2.0,', 'seg2-v1-a1.mp4', '#EXT-X-ENDLIST', ''].join(NL)
      );
    return true;
  }
  const m = /^real\/seg([12])-v1-a1\.mp4$/.exec(rel);
  if (m) {
    try {
      const buf = await readFile(path.join(fixturesDir, 'ts', `seg00${Number(m[1]) - 1}.ts`));
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': buf.length }).end(buf);
    } catch {
      res.writeHead(404).end('no segment');
    }
    return true;
  }
  res.writeHead(404).end('not found');
  return true;
}

/**
 * 再一组：缺 Referer 时回 **404**（不是 403/410）。
 * 真实站点就这么干——播放列表能取，分片却 404，用来验证「404 也要触发页面身份重发」。
 */
export async function handlePhStyle(req, res, pathname, fixturesDir, prefix = '/phstyle/') {
  if (!pathname.startsWith(prefix)) return false;
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  const ok = refererAllowed(req);
  const notFound = () => res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');

  if (rel === 'index-v1-a1.m3u8') {
    // 播放列表不带 Referer 也给（和 PH 一样）
    res
      .writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      .end(
        ['#EXTM3U', '#EXT-X-TARGETDURATION:5', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:1', '#EXTINF:2.000,', 'seg-1-v1-a1.ts?validfrom=1&hash=abc', '#EXTINF:2.000,', 'seg-2-v1-a1.ts?validfrom=1&hash=abc', '#EXT-X-ENDLIST', ''].join(NL)
      );
    return true;
  }
  // 注意名字里有连字符：seg-1-v1-a1.ts（之前写成 seg1 导致路由永远 404）
  const m = /^seg-?([12])-v1-a1\.ts$/.exec(rel.split('?')[0]);
  if (m) {
    // 分片：没带本站 Referer 就 404
    if (!ok) return notFound() || true;
    try {
      const buf = await readFile(path.join(fixturesDir, 'ts', `seg00${Number(m[1]) - 1}.ts`));
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': buf.length }).end(buf);
    } catch {
      notFound();
    }
    return true;
  }
  notFound();
  return true;
}
