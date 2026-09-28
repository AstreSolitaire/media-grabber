// 用 ffmpeg 生成测试用的真实媒体流。已存在就跳过，重复跑很快。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
export const FIXTURES = path.join(import.meta.dirname, 'tmp', 'fixtures');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ff(args, opts = {}) {
  try {
    return await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
  } catch (e) {
    throw new Error(`ffmpeg 失败：${e.stderr || e.message}`);
  }
}

const VIDEO = (size, rate) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`];
const AUDIO = (freq = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000`];

// B 帧是重点：它会让 PTS != DTS，从而必须写 ctts 才能对齐画面
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-bf', '2', '-g', '60'];
const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];

export async function ensureFixtures() {
  await mkdir(FIXTURES, { recursive: true });

  // 1. 常规 TS 分片 HLS
  const ts = path.join(FIXTURES, 'ts');
  if (!(await exists(path.join(ts, 'index.m3u8')))) {
    await mkdir(ts, { recursive: true });
    await ff([
      ...VIDEO('1280x720', 30), ...AUDIO(), '-t', '6',
      ...X264, ...AAC,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(ts, 'seg%03d.ts'),
      path.join(ts, 'index.m3u8'),
    ]);
  }

  // 2. 1080p：验证 SPS 裁剪计算（1920x1080 一定是裁剪出来的）
  const ts1080 = path.join(FIXTURES, 'ts1080');
  if (!(await exists(path.join(ts1080, 'index.m3u8')))) {
    await mkdir(ts1080, { recursive: true });
    await ff([
      ...VIDEO('1920x1080', 25), ...AUDIO(660), '-t', '4',
      ...X264, ...AAC,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(ts1080, 'seg%03d.ts'),
      path.join(ts1080, 'index.m3u8'),
    ]);
  }

  // 3. 多码率 master playlist
  const master = path.join(FIXTURES, 'master');
  if (!(await exists(path.join(master, 'master.m3u8')))) {
    await mkdir(path.join(master, 'lo'), { recursive: true });
    await mkdir(path.join(master, 'hi'), { recursive: true });
    await ff([
      ...VIDEO('640x360', 30), ...AUDIO(), '-t', '4',
      ...X264, '-b:v', '300k', '-maxrate', '300k', '-bufsize', '600k', ...AAC,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(master, 'lo', 's%03d.ts'),
      path.join(master, 'lo', 'index.m3u8'),
    ]);
    await ff([
      ...VIDEO('1280x720', 30), ...AUDIO(), '-t', '4',
      ...X264, '-b:v', '1500k', '-maxrate', '1500k', '-bufsize', '3000k', ...AAC,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(master, 'hi', 's%03d.ts'),
      path.join(master, 'hi', 'index.m3u8'),
    ]);
    await writeFile(
      path.join(master, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=400000,AVERAGE-BANDWIDTH=380000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=30.000',
        'lo/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1800000,AVERAGE-BANDWIDTH=1700000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30.000',
        'hi/index.m3u8',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  // 4. AES-128 加密（IV 由序号推导）
  const aes = path.join(FIXTURES, 'aes');
  if (!(await exists(path.join(aes, 'index.m3u8')))) {
    await mkdir(aes, { recursive: true });
    const key = randomBytes(16);
    await writeFile(path.join(aes, 'enc.key'), key);
    await writeFile(path.join(aes, 'keyinfo'), `enc.key\n${path.join(aes, 'enc.key').replace(/\\/g, '/')}\n`, 'utf8');
    await ff([
      ...VIDEO('640x360', 24), ...AUDIO(330), '-t', '4',
      ...X264, ...AAC,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_key_info_file', path.join(aes, 'keyinfo'),
      '-hls_segment_filename', path.join(aes, 'seg%03d.ts'),
      path.join(aes, 'index.m3u8'),
    ]);
  }

  // 5. AES-128 加密，且播放列表里显式给 IV
  const aesIv = path.join(FIXTURES, 'aesiv');
  if (!(await exists(path.join(aesIv, 'index.m3u8')))) {
    await mkdir(aesIv, { recursive: true });
    const key = randomBytes(16);
    await writeFile(path.join(aesIv, 'enc.key'), key);
    await writeFile(
      path.join(aesIv, 'keyinfo'),
      `enc.key\n${path.join(aesIv, 'enc.key').replace(/\\/g, '/')}\n0123456789abcdef0123456789abcdef\n`,
      'utf8'
    );
    await ff([
      ...VIDEO('640x360', 24), ...AUDIO(330), '-t', '4',
      ...X264, ...AAC,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_key_info_file', path.join(aesIv, 'keyinfo'),
      '-hls_segment_filename', path.join(aesIv, 'seg%03d.ts'),
      path.join(aesIv, 'index.m3u8'),
    ]);
  }

  // 6. fMP4 分片（出现 EXT-X-MAP，不需要重封装）
  // 注意：init 文件名如果给绝对路径，ffmpeg 会把绝对路径原样写进播放列表，所以这里用 cwd 相对路径
  const fmp4 = path.join(FIXTURES, 'fmp4');
  if (!(await exists(path.join(fmp4, 'index.m3u8')))) {
    await mkdir(fmp4, { recursive: true });
    await ff(
      [
        ...VIDEO('640x360', 30), ...AUDIO(550), '-t', '4',
        ...X264, ...AAC,
        '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '2', '-hls_list_size', '0',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', 'seg%03d.m4s',
        'index.m3u8',
      ],
      { cwd: fmp4 }
    );
  }

  // 7. 只有音频的 TS 分片 HLS
  const audioTs = path.join(FIXTURES, 'audiotts');
  if (!(await exists(path.join(audioTs, 'index.m3u8')))) {
    await mkdir(audioTs, { recursive: true });
    await ff([
      ...AUDIO(220), '-t', '4', '-vn', ...AAC,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(audioTs, 'seg%03d.ts'),
      path.join(audioTs, 'index.m3u8'),
    ]);
  }

  // 8. 裸 ADTS AAC 文件
  if (!(await exists(path.join(FIXTURES, 'audio.aac')))) {
    await ff([...AUDIO(880), '-t', '4', '-vn', ...AAC, '-f', 'adts', path.join(FIXTURES, 'audio.aac')]);
  }

  // 9. 裸 MP3 文件
  if (!(await exists(path.join(FIXTURES, 'audio.mp3')))) {
    await ff([...AUDIO(990), '-t', '4', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(FIXTURES, 'audio.mp3')]);
  }

  // 10. 单文件 + 字节范围播放列表（EXT-X-BYTERANGE）
  const byterange = path.join(FIXTURES, 'byterange');
  if (!(await exists(path.join(byterange, 'index.m3u8')))) {
    await mkdir(byterange, { recursive: true });
    const src = path.join(FIXTURES, 'ts');
    const segs = ['seg000.ts', 'seg001.ts', 'seg002.ts'];
    const parts = [];
    let offset = 0;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (const s of segs) {
      const buf = await readFile(path.join(src, s));
      lines.push('#EXTINF:2.00000,');
      lines.push(`#EXT-X-BYTERANGE:${buf.length}@${offset}`);
      lines.push('all.ts');
      offset += buf.length;
      parts.push(buf);
    }
    lines.push('#EXT-X-ENDLIST', '');
    await writeFile(path.join(byterange, 'all.ts'), Buffer.concat(parts));
    await writeFile(path.join(byterange, 'index.m3u8'), lines.join('\n'), 'utf8');
  }

  // 11. 直播风格播放列表（没有 ENDLIST），只验证解析与提示
  const live = path.join(FIXTURES, 'live');
  if (!(await exists(path.join(live, 'index.m3u8')))) {
    await mkdir(live, { recursive: true });
    await ff([
      ...VIDEO('320x240', 15), ...AUDIO(440), '-t', '4',
      ...X264, ...AAC,
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(live, 's%03d.ts'),
      path.join(live, 'index.m3u8'),
    ]);
    const text = await readFile(path.join(live, 'index.m3u8'), 'utf8');
    await writeFile(path.join(live, 'index.m3u8'), text.replace('#EXT-X-ENDLIST\n', ''), 'utf8');
  }

  return FIXTURES;
}

if (process.argv[1] && process.argv[1].endsWith('make-fixtures.mjs')) {
  ensureFixtures()
    .then((dir) => console.log('fixtures 就绪：' + dir))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
