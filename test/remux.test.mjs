// 端到端验证：真实 HLS 流 → downloadHls 抓取 → remuxToMp4 重封装 → ffprobe 校验 + 完整解码。
// 这是整个扩展最关键的一环，必须确认产物能被播放器正常解码。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureFixtures, FIXTURES } from './make-fixtures.mjs';
import { startServer } from './static-server.mjs';
import { downloadHls, probeHls, pickBestVariant } from '../extension/src/lib/hls.js';
import { remuxToMp4, probeContainer } from '../extension/src/lib/ts2mp4.js';
import { concatUint8 } from '../extension/src/lib/util.js';

const exec = promisify(execFile);
const OUT = path.join(FIXTURES, '..', 'out');

let server;

before(async () => {
  await ensureFixtures();
  await mkdir(OUT, { recursive: true });
  server = await startServer(FIXTURES);
});

after(async () => {
  if (server) await server.close();
});

async function fetchHls(url, opts = {}) {
  const parts = [];
  const res = await downloadHls({
    url,
    fetchImpl: fetch,
    concurrency: 3,
    retries: 1,
    ...opts,
    onData: async (b) => parts.push(b),
  });
  return { data: concatUint8(parts), res };
}

async function ffprobe(file, extra = []) {
  const { stdout } = await exec('ffprobe', [
    '-hide_banner',
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    ...extra,
    file,
  ]);
  return JSON.parse(stdout);
}

/** 完整解码一遍，任何报错都会出现在 stderr 里；返回 stderr 内容。 */
async function decode(file, level = 'error') {
  try {
    const { stderr } = await exec('ffmpeg', ['-hide_banner', '-v', level, '-i', file, '-f', 'null', '-'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stderr;
  } catch (e) {
    return (e.stderr || '') + (e.message || '');
  }
}

async function save(name, data) {
  const file = path.join(OUT, name);
  await writeFile(file, data);
  return file;
}

function videoStream(info) {
  return info.streams.find((s) => s.codec_type === 'video');
}
function audioStream(info) {
  return info.streams.find((s) => s.codec_type === 'audio');
}

async function assertPlayable(file, { note = '' } = {}) {
  const stderr = await decode(file, 'warning');
  const bad = stderr.split('\n').filter((l) => /non-monotonic|Invalid|corrupt|error|Error|missing/i.test(l));
  assert.equal(bad.length, 0, `产物解码有问题${note ? '（' + note + '）' : ''}：\n${stderr}`);
}

test('TS 分片 HLS：下载后转成 MP4，画面尺寸与时长正确', async () => {
  const { data, res } = await fetchHls(server.base + 'ts/index.m3u8');
  assert.equal(res.count, 3);
  assert.equal(probeContainer(data), 'ts');

  const out = await remuxToMp4(data);
  assert.equal(out.ext, '.mp4');
  assert.equal(out.videoCodec, 'avc1');
  assert.equal(out.audioCodec, 'aac');
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);

  const file = await save('ts-720p.mp4', out.data);
  const info = await ffprobe(file, ['-count_frames']);
  const v = videoStream(info);
  const a = audioStream(info);
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 1280);
  assert.equal(v.height, 720);
  assert.equal(a.codec_name, 'aac');
  assert.equal(Number(a.channels), 2);
  assert.equal(Number(a.sample_rate), 48000);
  assert.ok(Math.abs(Number(info.format.duration) - 6) < 0.35, `时长 ${info.format.duration} 偏离 6s`);
  // 6 秒 30fps 大约 180 帧
  assert.ok(Math.abs(Number(v.nb_read_frames) - 180) <= 3, `帧数 ${v.nb_read_frames} 不等于 180 左右`);
  await assertPlayable(file);
});

test('1080p 的 SPS 裁剪能算出正确分辨率', async () => {
  const { data } = await fetchHls(server.base + 'ts1080/index.m3u8');
  const out = await remuxToMp4(data);
  assert.equal(out.width, 1920, '1920x1080 必须靠裁剪字段算出，不能是 1088 或 0');
  assert.equal(out.height, 1080);
  const file = await save('ts-1080p.mp4', out.data);
  const info = await ffprobe(file);
  assert.equal(videoStream(info).height, 1080);
  assert.equal(videoStream(info).width, 1920);
  await assertPlayable(file);
});

test('多码率 master：默认挑最高清晰度，也能按用户选择挑低的', async () => {
  const info = await probeHls({ url: server.base + 'master/master.m3u8', fetchImpl: fetch });
  assert.equal(info.type, 'master');
  assert.equal(info.variants.length, 2);

  const hi = await fetchHls(server.base + 'master/master.m3u8');
  const hiOut = await remuxToMp4(hi.data);
  assert.equal(hiOut.width, 1280);
  const hiFile = await save('master-hi.mp4', hiOut.data);
  await assertPlayable(hiFile, { note: '高码率' });

  const lo = await fetchHls(server.base + 'master/master.m3u8', {
    selectVariant: (variants) => variants.find((v) => v.resolution === '640x360'),
  });
  const loOut = await remuxToMp4(lo.data);
  assert.equal(loOut.width, 640);
  const loFile = await save('master-lo.mp4', loOut.data);
  await assertPlayable(loFile, { note: '低码率' });
});

test('AES-128 加密（IV 由序号推导）能正确解密并转封装', async () => {
  const { data, res } = await fetchHls(server.base + 'aes/index.m3u8');
  assert.equal(res.encryption.method, 'AES-128');
  const out = await remuxToMp4(data);
  assert.equal(out.width, 640);
  assert.equal(out.height, 360);
  const file = await save('aes.mp4', out.data);
  const info = await ffprobe(file);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.3);
  await assertPlayable(file, { note: 'AES 加密流' });
});

test('AES-128 加密（播放列表显式给 IV）同样正确', async () => {
  const { data } = await fetchHls(server.base + 'aesiv/index.m3u8');
  const out = await remuxToMp4(data);
  const file = await save('aesiv.mp4', out.data);
  const info = await ffprobe(file);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.3);
  await assertPlayable(file, { note: '显式 IV' });
});

test('fMP4 分片（EXT-X-MAP）直接拼接即可播放', async () => {
  const { data, res } = await fetchHls(server.base + 'fmp4/index.m3u8');
  assert.equal(res.hasMap, true);
  assert.equal(probeContainer(data), 'fmp4');
  const file = await save('fmp4.mp4', data);
  const info = await ffprobe(file);
  assert.equal(videoStream(info).codec_name, 'h264');
  assert.equal(videoStream(info).width, 640);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.4);
  await assertPlayable(file, { note: 'fMP4 拼接' });
});

test('EXT-X-BYTERANGE 单文件分片能正确按范围取数', async () => {
  const { data, res } = await fetchHls(server.base + 'byterange/index.m3u8');
  assert.equal(res.count, 3);
  const out = await remuxToMp4(data);
  assert.equal(out.width, 1280);
  const file = await save('byterange.mp4', out.data);
  const info = await ffprobe(file);
  assert.ok(Math.abs(Number(info.format.duration) - 6) < 0.35, `时长 ${info.format.duration} 偏离 6s`);
  await assertPlayable(file, { note: '字节范围分片' });
});

test('只有音频的 TS 流会输出 m4a', async () => {
  const { data } = await fetchHls(server.base + 'audiotts/index.m3u8');
  const out = await remuxToMp4(data);
  assert.equal(out.ext, '.m4a');
  assert.equal(out.videoCodec, '');
  assert.equal(out.audioCodec, 'aac');
  const file = await save('audio-only.m4a', out.data);
  const info = await ffprobe(file);
  assert.equal(info.streams.length, 1);
  assert.equal(audioStream(info).codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.3);
  await assertPlayable(file, { note: '纯音频 TS' });
});

test('裸 ADTS AAC 文件能转成 m4a', async () => {
  const data = new Uint8Array(await readFile(path.join(FIXTURES, 'audio.aac')));
  assert.equal(probeContainer(data), 'adts');
  const out = await remuxToMp4(data);
  assert.equal(out.ext, '.m4a');
  assert.equal(out.audioCodec, 'aac');
  const file = await save('raw-aac.m4a', out.data);
  const info = await ffprobe(file);
  assert.equal(audioStream(info).codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.3);
  await assertPlayable(file, { note: '裸 AAC' });
});

test('裸 MP3 文件能转成 m4a', async () => {
  const data = new Uint8Array(await readFile(path.join(FIXTURES, 'audio.mp3')));
  assert.equal(probeContainer(data), 'mp3');
  const out = await remuxToMp4(data);
  assert.equal(out.ext, '.m4a');
  assert.equal(out.audioCodec, 'mp3');
  const file = await save('raw-mp3.m4a', out.data);
  const info = await ffprobe(file);
  assert.equal(audioStream(info).codec_name, 'mp3');
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.3);
  await assertPlayable(file, { note: '裸 MP3' });
});

test('直播风格列表（无 ENDLIST）会被标记出来', async () => {
  const info = await probeHls({ url: server.base + 'live/index.m3u8', fetchImpl: fetch });
  assert.equal(info.isLive, true);
  assert.ok(info.segmentCount >= 1);
  const { data, res } = await fetchHls(server.base + 'live/index.m3u8');
  assert.equal(res.isLive, true);
  const out = await remuxToMp4(data);
  assert.equal(out.width, 320);
  const file = await save('live.mp4', out.data);
  await assertPlayable(file, { note: '直播窗口' });
});

test('无法识别的数据会明确报错而不是产出坏文件', async () => {
  await assert.rejects(remuxToMp4(new Uint8Array(1024).fill(0x5a)), /无法识别的容器/);
});
