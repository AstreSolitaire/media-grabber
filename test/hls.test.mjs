// 播放列表解析 + 下载流程的单测。用内存里的假 fetch，不依赖网络和磁盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parsePlaylist, probeHls, downloadHls, variantLabel, parseAttributes, pickBestVariant } from '../extension/src/lib/hls.js';
import { sequenceToIv } from '../extension/src/lib/aes.js';
import { concatUint8 } from '../extension/src/lib/util.js';

function stubFetch(files, headers = {}) {
  return async (url) => {
    const key = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (!(key in files)) return new Response('not found', { status: 404 });
    const body = files[key];
    return new Response(body, {
      status: 200,
      headers: { 'content-type': headers[key] || 'application/octet-stream' },
    });
  };
}

test('解析属性串时不受引号内逗号影响', () => {
  const a = parseAttributes('BANDWIDTH=1800000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720');
  assert.equal(a.BANDWIDTH, '1800000');
  assert.equal(a.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(a.RESOLUTION, '1280x720');
});

test('解析 master 播放列表并按带宽挑最高清晰度', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="国语",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
    'lo/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30',
    'hi/index.m3u8',
    '',
  ].join('\n');
  const p = parsePlaylist(text, 'https://cdn.example.com/vod/master.m3u8');
  assert.equal(p.type, 'master');
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[1].url, 'https://cdn.example.com/vod/hi/index.m3u8');
  assert.equal(p.renditions.length, 1);
  assert.equal(p.renditions[0].url, 'https://cdn.example.com/vod/audio.m3u8');
  const best = pickBestVariant(p.variants);
  assert.equal(best.resolution, '1280x720');
  assert.match(variantLabel(p.variants[1], 1), /720p/);
});

test('解析媒体播放列表：EXTINF / KEY / 字节范围 / MAP / 直播标记', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:5',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="800@0"',
    '#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x00000000000000000000000000000001',
    '#EXTINF:5.005,',
    '#EXT-X-BYTERANGE:1000@800',
    'seg.ts',
    '#EXT-X-BYTERANGE:2000',
    'seg.ts',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4.0,',
    'plain.ts',
    '',
  ].join('\n');
  const p = parsePlaylist(text, 'https://x.test/a/b/index.m3u8');
  assert.equal(p.type, 'media');
  assert.equal(p.isLive, true);
  assert.equal(p.targetDuration, 6);
  assert.equal(p.segments.length, 3);
  assert.equal(p.map.url, 'https://x.test/a/b/init.mp4');
  assert.deepEqual(p.map.byteRange, { length: 800, offset: 0 });
  // 第一个分片带显式 offset
  assert.deepEqual(p.segments[0].byteRange, { length: 1000, offset: 800 });
  assert.deepEqual(p.segments[0].key.uri, 'https://x.test/a/b/k.bin');
  // 第二个分片省略 offset 时，应该紧接上一段
  assert.deepEqual(p.segments[1].byteRange, { length: 2000, offset: 1800 });
  assert.equal(p.segments[1].seq, 6);
  // KEY 变回 NONE 之后不再加密
  assert.equal(p.segments[2].key, null);
  // 第二个分片没写 EXTINF，回退用 TARGETDURATION=6，第三个是 4.0
  assert.equal(p.duration, 5.005 + 6 + 4.0);
  assert.deepEqual(p.encryption, { methods: ['AES-128'], method: 'AES-128' });
});

test('probeHls 能给出清晰度列表', async () => {
  const files = {
    'vod/master.m3u8': ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360', 'lo/index.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720', 'hi/index.m3u8', ''].join('\n'),
  };
  const info = await probeHls({ url: 'https://x.test/vod/master.m3u8', fetchImpl: stubFetch(files) });
  assert.equal(info.type, 'master');
  assert.equal(info.variants.length, 2);
  assert.equal(info.variants[1].resolution, '1280x720');
  assert.match(info.variants[1].label, /720p/);
});

test('没有 IV 属性时按分片序号推导 IV', async () => {
  const key = crypto.randomBytes(16);
  const plain0 = crypto.randomBytes(4096);
  const plain1 = crypto.randomBytes(2048);
  const enc = (plain, iv) => {
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([c.update(plain), c.final()]);
  };
  const seg0 = enc(plain0, sequenceToIv(0));
  const seg1 = enc(plain1, sequenceToIv(1));
  const files = {
    'aes/index.m3u8': [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"',
      '#EXTINF:4,',
      's0.ts',
      '#EXTINF:4,',
      's1.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
    'aes/k.bin': key,
    'aes/s0.ts': seg0,
    'aes/s1.ts': seg1,
  };
  const parts = [];
  const res = await downloadHls({
    url: 'https://x.test/aes/index.m3u8',
    fetchImpl: stubFetch(files),
    onData: async (b) => parts.push(b),
    cryptoImpl: crypto.webcrypto,
  });
  assert.equal(res.count, 2);
  assert.equal(res.encryption.method, 'AES-128');
  const got = Buffer.from(concatUint8(parts));
  assert.equal(got.toString('hex'), Buffer.concat([plain0, plain1]).toString('hex'));
});

test('EXT-X-MAP 会排在所有分片之前', async () => {
  const files = {
    'f/index.m3u8': ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:2,', 's0.m4s', '#EXTINF:2,', 's1.m4s', '#EXT-X-ENDLIST', ''].join('\n'),
    'f/init.mp4': Buffer.from('INIT'),
    'f/s0.m4s': Buffer.from('SEG0'),
    'f/s1.m4s': Buffer.from('SEG1'),
  };
  const order = [];
  await downloadHls({
    url: 'https://x.test/f/index.m3u8',
    fetchImpl: stubFetch(files),
    onData: async (b, m) => order.push(m.kind + ':' + Buffer.from(b).toString()),
  });
  assert.deepEqual(order, ['init:INIT', 'segment:SEG0', 'segment:SEG1']);
});

test('DRM 加密会给出明确报错，而不是静默下成乱码', async () => {
  const files = {
    'd/index.m3u8': [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXTINF:4,',
      's0.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  };
  await assert.rejects(
    downloadHls({ url: 'https://x.test/d/index.m3u8', fetchImpl: stubFetch(files), onData: async () => {} }),
    /DRM/
  );
});

test('分片抓取失败会带上下载进度再报错', async () => {
  const files = {
    'e/index.m3u8': ['#EXTM3U', '#EXTINF:2,', 's0.ts', '#EXTINF:2,', 's1.ts', '#EXT-X-ENDLIST', ''].join('\n'),
    'e/s0.ts': Buffer.from('OK'),
  };
  await assert.rejects(
    downloadHls({ url: 'https://x.test/e/index.m3u8', fetchImpl: stubFetch(files), onData: async () => {}, retries: 0 }),
    /下载分片失败.*1\/2/
  );
});

test('多码率列表里可以指定选低码率', async () => {
  const files = {
    'm/master.m3u8': ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360', 'lo/i.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720', 'hi/i.m3u8', ''].join('\n'),
    'm/lo/i.m3u8': ['#EXTM3U', '#EXTINF:2,', 'a.ts', '#EXT-X-ENDLIST', ''].join('\n'),
    'm/hi/i.m3u8': ['#EXTM3U', '#EXTINF:2,', 'b.ts', '#EXT-X-ENDLIST', ''].join('\n'),
    'm/lo/a.ts': Buffer.from('LO'),
    'm/hi/b.ts': Buffer.from('HI'),
  };
  const parts = [];
  const res = await downloadHls({
    url: 'https://x.test/m/master.m3u8',
    fetchImpl: stubFetch(files),
    onData: async (b) => parts.push(b),
    selectVariant: (variants) => variants.find((v) => v.resolution === '640x360'),
  });
  assert.equal(res.variant.resolution, '640x360');
  assert.equal(Buffer.from(concatUint8(parts)).toString(), 'LO');
});
