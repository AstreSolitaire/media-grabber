// 本轮新增能力的单测：图片类型识别、嗅探白名单、体积估算、探测结果的时长与预估大小。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isImageKind, isMediaKind, worthSniffing, isImageContentType, TINY_IMAGE_BYTES } from '../extension/src/lib/detect.js';
import { estimateBytes, formatDuration, formatBytes, isBlockedStatus, explainHttpStatus } from '../extension/src/lib/util.js';
import { probeHls } from '../extension/src/lib/hls.js';

test('按 Content-Type 识别图片', () => {
  const r = classify({ url: 'https://a.test/get?id=1', contentType: 'image/webp' });
  assert.equal(r.kind, 'image');
  assert.ok(isImageKind(r.kind));
  assert.ok(!isMediaKind(r.kind));
  assert.ok(isImageContentType('image/png; charset=binary'));
  assert.ok(!isImageContentType('video/mp4'));
});

test('按扩展名识别图片（含少见的 heic / avif）', () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'heif']) {
    const r = classify({ url: `https://a.test/pic.${ext}` });
    assert.equal(r.kind, 'image', ext + ' 应识别为图片');
  }
});

test('按 Content-Disposition 兜底识别图片', () => {
  const r = classify({ url: 'https://a.test/download?id=9', contentType: 'application/octet-stream', contentDisposition: 'attachment; filename="hi.png"' });
  assert.equal(r.kind, 'image');
});

test('嗅探白名单：图片按加载方式放行，脚本样式永远不看', () => {
  assert.ok(worthSniffing('https://a.test/a.jpg', { requestType: 'image' }));
  assert.ok(worthSniffing('https://a.test/a.png', { requestType: 'xmlhttprequest' }));
  assert.ok(!worthSniffing('https://a.test/a.jpg', { requestType: 'image', images: false }), '关掉图片后不应收录');
  assert.ok(!worthSniffing('https://a.test/a.png', { requestType: 'script' }), '脚本类型不算图片');
  assert.ok(!worthSniffing('https://a.test/app.js', { requestType: 'script' }));
  assert.ok(!worthSniffing('https://a.test/style.css', { requestType: 'stylesheet' }));
  assert.ok(!worthSniffing('https://a.test/f.woff2', { requestType: 'font' }));
  assert.ok(!worthSniffing('data:image/png;base64,AAAA', { requestType: 'image' }));
  // 媒体直链照旧
  assert.ok(worthSniffing('https://a.test/v.mp4', { requestType: 'media' }));
  assert.ok(worthSniffing('https://a.test/list.m3u8', { requestType: 'xmlhttprequest' }));
});

test('小图标阈值是个正数，便于界面折叠', () => {
  assert.ok(TINY_IMAGE_BYTES > 0 && TINY_IMAGE_BYTES <= 8192);
});

test('体积估算：时长 × 码率 ÷ 8', () => {
  assert.equal(estimateBytes(10, 1000000), 1250000); // 10 秒 1Mbps ≈ 1.25MB
  assert.equal(estimateBytes(0, 1000000), 0);
  assert.equal(estimateBytes(10, 0), 0);
  assert.equal(estimateBytes(null, 100), 0);
  assert.equal(estimateBytes('abc', 100), 0);
});

test('时长格式化', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(NaN), '0:00');
});

test('formatBytes：lib 版对 0 返回 “0 B”，UI 版对 0 返回空串（表示大小未知）', () => {
  // util.js 的契约
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes(NaN), '');
  assert.equal(formatBytes(2048), '2.0 KB');
});

// ---------------------------------------------------------------- 探测体积

function stubFetch(files, headers = {}) {
  return async (url) => {
    const key = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (!(key in files)) return new Response('not found', { status: 404 });
    return new Response(files[key], { status: 200, headers: headers[key] || { 'content-type': 'application/octet-stream' } });
  };
}

test('多码率列表：按时长与声明码率算出每档大概多大', async () => {
  const media = ['#EXTM3U', '#EXT-X-TARGETDURATION:5', '#EXTINF:5,', 'a.ts', '#EXTINF:5,', 'b.ts', '#EXT-X-ENDLIST', ''].join('\n');
  const files = {
    'vod/master.m3u8': [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360',
      'lo/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      'hi/index.m3u8',
      '',
    ].join('\n'),
    'vod/lo/index.m3u8': media,
    'vod/hi/index.m3u8': media,
  };
  const info = await probeHls({ url: 'https://x.test/vod/master.m3u8', fetchImpl: stubFetch(files) });
  assert.equal(info.type, 'master');
  assert.equal(info.variants.length, 2);
  // 10 秒 × 1Mbps ÷ 8 = 1.25MB，×2Mbps = 2.5MB
  assert.equal(info.variants[0].durationSec, 10);
  assert.equal(info.variants[0].estimatedBytes, 1250000);
  assert.equal(info.variants[1].estimatedBytes, 2500000);
  // 总览取最大的一档
  assert.equal(info.estimatedBytes, 2500000);
});

test('单码率列表：用第一个分片的真实大小按时间比例推算', async () => {
  const files = {
    'vod/index.m3u8': [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:5',
      '#EXTINF:5,',
      'a.ts',
      '#EXTINF:5,',
      'b.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
    'vod/a.ts': 'x',
  };
  const info = await probeHls({
    url: 'https://x.test/vod/index.m3u8',
    fetchImpl: stubFetch(files, { 'vod/a.ts': { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-0/500000' } }),
  });
  assert.equal(info.type, 'media');
  assert.equal(info.duration, 10);
  // 首片 500000 字节 / 5 秒 × 10 秒
  assert.equal(info.estimatedBytes, 1000000);
});

test('拿不到分片大小时只给时长，不瞎猜体积', async () => {
  const files = {
    'vod/index.m3u8': ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST', ''].join('\n'),
    'vod/a.ts': 'x',
  };
  const info = await probeHls({ url: 'https://x.test/vod/index.m3u8', fetchImpl: stubFetch(files) });
  assert.equal(info.duration, 4);
  assert.equal(info.estimatedBytes, 0);
});

test('withSizes=false 时不去读每档列表（用于只想看清晰度的场合）', async () => {
  let calls = 0;
  const base = stubFetch({
    'm/master.m3u8': ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'hi/i.m3u8', ''].join('\n'),
    'm/hi/i.m3u8': ['#EXTM3U', '#EXTINF:5,', 'a.ts', '#EXT-X-ENDLIST', ''].join('\n'),
  });
  const info = await probeHls({
    url: 'https://x.test/m/master.m3u8',
    fetchImpl: (u, i) => {
      calls++;
      return base(u, i);
    },
    withSizes: false,
  });
  assert.equal(calls, 1, '只应该读一次主列表');
  assert.equal(info.variants[0].estimatedBytes, 0);
});

test('防盗链相关的状态码判定与说明', () => {
  for (const c of [401, 403, 410, 451]) assert.ok(isBlockedStatus(c), c + ' 应算被拦');
  for (const c of [200, 206, 301, 404, 429, 500]) assert.ok(!isBlockedStatus(c), c + ' 不算被拦');

  // 410/403 的说明里必须带上「怎么办」，不能只是个状态码
  const m410 = explainHttpStatus(410, '取分片');
  assert.match(m410, /防盗链/);
  assert.match(m410, /刷新/);
  assert.match(explainHttpStatus(403), /防盗链/);
  assert.match(explainHttpStatus(401), /登录/);
  assert.match(explainHttpStatus(404), /过期/);
  assert.match(explainHttpStatus(429), /并发/);
  assert.match(explainHttpStatus(500), /稍后/);
  assert.equal(explainHttpStatus(418), 'HTTP 418');
});

test('probeHls 会带回分片地址，供界面折叠误列出来的分片', async () => {
  const files = {
    'a/index.m3u8': ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MAP:URI="init-v1-a1.mp4"', '#EXTINF:2,', 'seg1-v1-a1.mp4', '#EXTINF:2,', 'seg2-v1-a1.mp4', '#EXT-X-ENDLIST', ''].join(String.fromCharCode(10)),
    'a/init-v1-a1.mp4': 'x',
    'a/seg1-v1-a1.mp4': 'y',
    'a/seg2-v1-a1.mp4': 'z',
  };
  const info = await probeHls({
    url: 'https://x.test/a/index.m3u8',
    fetchImpl: stubFetch(files, { 'a/init-v1-a1.mp4': { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/1000' } }),
  });
  assert.equal(info.type, 'media');
  assert.ok(info.segmentUrls.some((u) => u.endsWith('init-v1-a1.mp4')), 'EXT-X-MAP 的 init 也要收进来');
  assert.ok(info.segmentUrls.some((u) => u.endsWith('seg1-v1-a1.mp4')));
  assert.ok(info.segmentUrls.some((u) => u.endsWith('seg2-v1-a1.mp4')));
});
