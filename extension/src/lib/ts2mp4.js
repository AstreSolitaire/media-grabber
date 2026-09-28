// 把 MPEG-TS / ADTS-AAC / MP3 等流式容器重新封装成 MP4，让手机播放器能直接播。
// 只换容器不重编码，画质无损，速度取决于内存带宽。
// 不依赖浏览器 API，可在 Node 里直接测试。

import { concatUint8 } from './util.js';

const PKT = 188;
const VIDEO_STREAM_TYPES = new Set([0x1b, 0x24]); // H.264 / H.265
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11]); // MPEG1/2 音频、AAC(ADTS)、AAC(LATM)

/** 判断一段数据的容器类型。 */
export function probeContainer(bytes, offset = 0) {
  const b = bytes;
  if (b.length - offset < 16) return 'unknown';

  // MPEG-TS：连续三个包同步字
  const scanEnd = Math.min(offset + PKT * 2, b.length - 2 * PKT);
  for (let i = offset; i < scanEnd; i++) {
    if (b[i] === 0x47 && b[i + PKT] === 0x47 && b[i + 2 * PKT] === 0x47) return 'ts';
  }
  // ID3 开头的文件很常见，先跳过标签
  if (b[offset] === 0x49 && b[offset + 1] === 0x44 && b[offset + 2] === 0x33) {
    const size = ((b[offset + 6] & 0x7f) << 21) | ((b[offset + 7] & 0x7f) << 14) | ((b[offset + 8] & 0x7f) << 7) | (b[offset + 9] & 0x7f);
    const off = offset + 10 + size;
    return off < b.length - 15 ? probeContainer(b, off) : 'unknown';
  }
  if (b[offset + 4] === 0x66 && b[offset + 5] === 0x74 && b[offset + 6] === 0x79 && b[offset + 7] === 0x70) return 'fmp4';
  if (b[offset] === 0xff && (b[offset + 1] & 0xf6) === 0xf0) return 'adts';
  if (b[offset] === 0xff && (b[offset + 1] & 0xe0) === 0xe0 && ((b[offset + 1] >> 1) & 0x03) !== 0) return 'mp3';
  return 'unknown';
}

// ---------------------------------------------------------------- 字节写入器

class Writer {
  constructor(cap = 1 << 16) {
    this.buf = new Uint8Array(cap);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length || 64;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v) {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  u24(v) {
    this.ensure(3);
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  u32(v) {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  u64(v) {
    const n = BigInt(v);
    this.u32(Number((n >> 32n) & 0xffffffffn));
    this.u32(Number(n & 0xffffffffn));
  }
  ascii(s) {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
  }
  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  zeros(n) {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
  }
  patchU32(off, v) {
    this.buf[off] = (v >>> 24) & 0xff;
    this.buf[off + 1] = (v >>> 16) & 0xff;
    this.buf[off + 2] = (v >>> 8) & 0xff;
    this.buf[off + 3] = v & 0xff;
  }
  patchU64(off, v) {
    const n = BigInt(v);
    this.patchU32(off, Number((n >> 32n) & 0xffffffffn));
    this.patchU32(off + 4, Number(n & 0xffffffffn));
  }
  out() {
    return this.buf.subarray(0, this.len);
  }
}

function beginBox(w, type) {
  w.u32(0);
  const off = w.len - 4;
  w.ascii(type);
  return off;
}

function endBox(w, off) {
  w.patchU32(off, w.len - off);
}

function fullBox(w, type, version = 0, flags = 0) {
  const off = beginBox(w, type);
  w.u8(version);
  w.u24(flags);
  return off;
}

const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function writeMatrix(w) {
  for (const v of UNITY_MATRIX) w.u32(v);
}

// ---------------------------------------------------------------- 位读取（SPS / slice header）

class BitReader {
  constructor(data, bitPos = 0) {
    this.d = data;
    this.p = bitPos;
  }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.d[this.p >> 3];
      if (byte === undefined) return v >>> 0;
      v = (v << 1) | ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v >>> 0;
  }
  ue() {
    let zeros = 0;
    while (this.p >> 3 < this.d.length && this.u(1) === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return ((1 << zeros) - 1 + this.u(zeros)) >>> 0;
  }
  se() {
    const k = this.ue();
    const v = Math.ceil(k / 2);
    return k % 2 === 0 ? -v : v;
  }
}

/** 从 SPS 里取宽高；失败返回 {width:0,height:0}。 */
export function parseSpsDimensions(sps) {
  try {
    const r = new BitReader(sps, 8);
    const profileIdc = r.u(8);
    r.u(8);
    r.u(8);
    r.ue();
    let chromaFormatIdc = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) r.u(1);
      r.ue();
      r.ue();
      r.u(1);
      if (r.u(1)) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (r.u(1)) {
            let last = 8;
            let next = 8;
            const size = i < 6 ? 16 : 64;
            for (let j = 0; j < size; j++) {
              if (next !== 0) next = (last + r.se() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue();
    } else if (pocType === 1) {
      r.u(1);
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue();
    r.u(1);
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);
    r.u(1);
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (r.u(1)) {
      cropLeft = r.ue();
      cropRight = r.ue();
      cropTop = r.ue();
      cropBottom = r.ue();
    }
    const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    const width = widthMbs * 16 - (cropLeft + cropRight) * subWidthC;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropTop + cropBottom) * subHeightC;
    if (width > 0 && width < 16384 && height > 0 && height < 16384) return { width, height };
  } catch {
    /* 拿不到就算了，不影响主流程 */
  }
  return { width: 0, height: 0 };
}

// ---------------------------------------------------------------- TS 解复用

function findSyncOffset(data, from = 0) {
  const limit = Math.min(data.length - 2 * PKT, from + PKT * 8);
  for (let i = from; i < Math.max(limit, from + 1); i++) {
    if (i + 2 * PKT < data.length && data[i] === 0x47 && data[i + PKT] === 0x47 && data[i + 2 * PKT] === 0x47) return i;
  }
  for (let i = from; i < Math.max(limit, from + 1); i++) {
    if (i + PKT < data.length && data[i] === 0x47 && data[i + PKT] === 0x47) return i;
  }
  return -1;
}

function readPts(b, o) {
  const hi = (b[o] & 0x0e) >> 1;
  const mid = ((b[o + 1] << 8) | b[o + 2]) >> 1;
  const lo = ((b[o + 3] << 8) | b[o + 4]) >> 1;
  return hi * 0x40000000 + mid * 0x8000 + lo;
}

function* eachPacket(data, syncOffset) {
  let off = syncOffset;
  while (off + PKT <= data.length) {
    if (data[off] !== 0x47) {
      const re = findSyncOffset(data, off + 1);
      if (re < 0) return;
      off = re;
      continue;
    }
    const b1 = data[off + 1];
    const pusi = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | data[off + 2];
    const b3 = data[off + 3];
    const afc = (b3 >> 4) & 0x03;
    let p = off + 4;
    if (afc & 2) {
      if (p >= off + PKT) {
        off += PKT;
        continue;
      }
      p += 1 + data[p];
      if (p > off + PKT) {
        off += PKT;
        continue;
      }
    }
    if (afc !== 0 && afc !== 2) {
      yield { pid, pusi, payload: data.subarray(p, off + PKT) };
    }
    off += PKT;
  }
}

/** 收集 PSI 段（支持跨包）。 */
function pushPsi(payload, pusi, state) {
  let p = payload;
  if (pusi) {
    if (p.length < 1) return null;
    state.buf = new Uint8Array(0);
    p = p.subarray(1 + Math.min(p[0], p.length - 1));
  }
  const buf = state.buf.length ? concatUint8([state.buf, p]) : p;
  if (buf.length < 3) {
    state.buf = buf;
    return null;
  }
  const total = 3 + (((buf[1] & 0x0f) << 8) | buf[2]);
  if (buf.length < total) {
    state.buf = buf;
    return null;
  }
  state.buf = new Uint8Array(0);
  return buf.subarray(0, total);
}

function parsePat(section) {
  const pids = [];
  const end = section.length - 4;
  for (let i = 8; i + 4 <= end; i += 4) {
    const programNumber = (section[i] << 8) | section[i + 1];
    const pid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
    if (programNumber !== 0) pids.push(pid);
  }
  return pids;
}

function parsePmt(section) {
  const streams = [];
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
  let p = 12 + programInfoLength;
  const end = section.length - 4;
  while (p + 5 <= end) {
    const streamType = section[p];
    const pid = ((section[p + 1] & 0x1f) << 8) | section[p + 2];
    const esInfoLength = ((section[p + 3] & 0x0f) << 8) | section[p + 4];
    streams.push({ streamType, pid });
    p += 5 + esInfoLength;
  }
  return streams;
}

function findStreams(data, syncOffset) {
  const psiState = new Map();
  const pmtPids = new Set();
  const streams = [];

  for (const pk of eachPacket(data, syncOffset)) {
    const pid = pk.pid;
    if (pid === 0x1fff) continue;
    if (!psiState.has(pid)) psiState.set(pid, { buf: new Uint8Array(0) });
    const section = pushPsi(pk.payload, pk.pusi, psiState.get(pid));
    if (!section) continue;
    if (pid === 0 && section[0] === 0x00) {
      for (const p of parsePat(section)) pmtPids.add(p);
    } else if (pmtPids.has(pid) && section[0] === 0x02) {
      for (const s of parsePmt(section)) {
        if (!streams.some((x) => x.pid === s.pid)) streams.push(s);
      }
      if (streams.length) break;
    }
  }
  return { streams };
}

const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0];
const MP3_BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000, 0], 2: [22050, 24000, 16000, 0], 0: [11025, 12000, 8000, 0] };

// ---------------------------------------------------------------- ES 拆解

/** 按起始码切 NAL，去掉尾部填充零。返回的是原数组的视图，不复制。 */
function splitAnnexB(data) {
  const out = [];
  let i = 0;
  let start = -1;
  const push = (from, to) => {
    let e = to;
    while (e > from && data[e - 1] === 0) e--;
    if (e > from) out.push(data.subarray(from, e));
  };
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        if (start >= 0) push(start, i);
        i += 3;
        start = i;
        continue;
      }
      if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
        if (start >= 0) push(start, i);
        i += 4;
        start = i;
        continue;
      }
    }
    i++;
  }
  if (start >= 0 && start < data.length) push(start, data.length);
  return out;
}

const NAL_AUD = 9;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_SEI = 6;

function isVcl(type) {
  return type >= 1 && type <= 5;
}

/** 读 slice header 的第一个 ue(v)：0 表示这是新图像的第一片。 */
function firstMbInSlice(nal) {
  try {
    return new BitReader(nal, 8).ue();
  } catch {
    return 0;
  }
}

/**
 * 把 H.264 的 PES 单元拼成访问单元（一帧一个样本）。
 * 关键点：不能按 PES 边界切，因为一帧可能跨多个 PES；只有 first_mb_in_slice==0 才是新帧。
 * 返回的 nals 都是原 TS 缓冲区的视图，不额外复制。
 */
export function buildAvcSamples(pesUnits) {
  const samples = [];
  let cur = null;
  let sps = null;
  let pps = null;

  const flush = () => {
    if (cur && cur.nals.length) samples.push(cur);
    cur = null;
  };
  const start = (pes) => {
    flush();
    cur = { nals: [], pts: pes.pts, dts: pes.dts };
  };

  for (const pes of pesUnits) {
    const data = pes.chunks.length === 1 ? pes.chunks[0] : concatUint8(pes.chunks);
    for (const nal of splitAnnexB(data)) {
      const type = nal[0] & 0x1f;
      if (type === NAL_SPS) {
        if (!sps) sps = nal;
        if (cur && cur.nals.some((n) => isVcl(n[0] & 0x1f))) start(pes);
        else if (!cur) start(pes);
      } else if (type === NAL_PPS) {
        if (!pps) pps = nal;
        if (!cur) start(pes);
      } else if (type === NAL_AUD) {
        start(pes);
      } else if (isVcl(type)) {
        if (!cur) start(pes);
        else if (firstMbInSlice(nal) === 0 && cur.nals.some((n) => isVcl(n[0] & 0x1f))) start(pes);
      } else if (type === NAL_SEI) {
        if (!cur) start(pes);
      } else if (!cur) {
        start(pes);
      }
      if (!cur) start(pes);
      cur.nals.push(nal);
    }
  }
  flush();
  return { samples, sps, pps };
}

function buildAvcC(sps, pps) {
  const w = new Writer(64);
  w.u8(1);
  w.u8(sps[1]);
  w.u8(sps[2]);
  w.u8(sps[3]);
  w.u8(0xff);
  w.u8(0xe1);
  w.u16(sps.length);
  w.bytes(sps);
  w.u8(1);
  w.u16(pps.length);
  w.bytes(pps);
  return w.out();
}

/** 解析 ADTS 帧序列（纯 .aac 也走这里）。 */
export function parseAdts(data) {
  const frames = [];
  let sampleRate = 0;
  let channels = 0;
  let profile = 1;
  let pos = 0;
  let skipped = 0;
  while (pos + 7 <= data.length) {
    if (data[pos] !== 0xff || (data[pos + 1] & 0xf6) !== 0xf0) {
      pos++;
      skipped++;
      continue;
    }
    const p = (data[pos + 2] >> 6) & 0x03;
    const sfIndex = (data[pos + 2] >> 2) & 0x0f;
    const chan = ((data[pos + 2] & 1) << 2) | ((data[pos + 3] >> 6) & 0x03);
    const frameLength = ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | ((data[pos + 5] >> 5) & 0x07);
    const headerLen = data[pos + 1] & 1 ? 7 : 9;
    if (frameLength <= headerLen || pos + frameLength > data.length) {
      pos++;
      skipped++;
      continue;
    }
    if (!sampleRate && ADTS_SAMPLE_RATES[sfIndex]) {
      sampleRate = ADTS_SAMPLE_RATES[sfIndex];
      channels = chan;
      profile = p;
    }
    frames.push(data.subarray(pos + headerLen, pos + frameLength));
    pos += frameLength;
  }
  return { frames, sampleRate: sampleRate || 44100, channels: channels || 2, profile, skipped };
}

/** 解析 MPEG 音频帧序列（mp3）。 */
export function parseMp3(data) {
  const frames = [];
  let sampleRate = 0;
  let channels = 0;
  let samplesPerFrame = 1152;
  let version = 3;
  let pos = 0;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff || (data[pos + 1] & 0xe0) !== 0xe0) {
      pos++;
      continue;
    }
    const v = (data[pos + 1] >> 3) & 0x03;
    const layer = (data[pos + 1] >> 1) & 0x03;
    const bitrateIndex = (data[pos + 2] >> 4) & 0x0f;
    const srIndex = (data[pos + 2] >> 2) & 0x03;
    const padding = (data[pos + 2] >> 1) & 0x01;
    const chanMode = (data[pos + 3] >> 6) & 0x03;
    const sr = (MP3_SAMPLE_RATES[v] || MP3_SAMPLE_RATES[3])[srIndex];
    const bitrate = (v === 3 ? MP3_BITRATE_V1_L3 : MP3_BITRATE_V2_L3)[bitrateIndex];
    if (layer !== 1 || !sr || !bitrate) {
      pos++;
      continue;
    }
    const spf = v === 3 ? 1152 : 576;
    const frameLen = Math.floor((spf / 8) * bitrate * 1000 / sr) + padding;
    if (frameLen <= 4 || pos + frameLen > data.length) {
      pos++;
      continue;
    }
    if (!sampleRate) {
      sampleRate = sr;
      channels = chanMode === 3 ? 1 : 2;
      samplesPerFrame = spf;
      version = v;
    }
    frames.push(data.subarray(pos, pos + frameLen));
    pos += frameLen;
  }
  return { frames, sampleRate: sampleRate || 44100, channels: channels || 2, samplesPerFrame, version };
}

// ---------------------------------------------------------------- MP4 盒子

function DESC(tag, payload) {
  const w = new Writer(payload.length + 6);
  w.u8(tag);
  if (payload.length >= 128) {
    const bytes = [];
    let n = payload.length;
    while (n > 0) {
      bytes.unshift(n & 0x7f);
      n >>= 7;
    }
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
    for (const b of bytes) w.u8(b);
  } else {
    w.u8(payload.length);
  }
  w.bytes(payload);
  return w.out();
}

function buildEsds(objectTypeIndication, asc, bitrate) {
  const dcd = new Writer(24);
  dcd.u8(objectTypeIndication);
  dcd.u8(0x15);
  dcd.u24(0);
  dcd.u32(bitrate);
  dcd.u32(bitrate);
  if (asc) dcd.bytes(DESC(0x05, asc));
  const esPayload = new Writer(24);
  esPayload.u16(0);
  esPayload.u8(0);
  esPayload.bytes(DESC(0x04, dcd.out()));
  esPayload.bytes(DESC(0x06, new Uint8Array([0x02])));
  const w = new Writer(64);
  w.u8(0);
  w.u24(0);
  w.bytes(DESC(0x03, esPayload.out()));
  return w.out();
}

function writeStts(w, deltas) {
  const runs = [];
  for (const d of deltas) {
    const last = runs[runs.length - 1];
    if (last && last.delta === d) last.count++;
    else runs.push({ count: 1, delta: d });
  }
  const off = fullBox(w, 'stts');
  w.u32(runs.length);
  for (const r of runs) {
    w.u32(r.count);
    w.u32(r.delta);
  }
  endBox(w, off);
}

function offMinMax(arr) {
  let min = arr.length ? arr[0] : 0;
  let max = min;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return { min, max };
}

function writeCtts(w, offsets) {
  const { min, max } = offMinMax(offsets);
  if (min === 0 && max === 0) return;
  const shift = Math.min(0, min);
  const runs = [];
  for (const o of offsets) {
    const v = o - shift;
    const last = runs[runs.length - 1];
    if (last && last.offset === v) last.count++;
    else runs.push({ count: 1, offset: v });
  }
  const off = fullBox(w, 'ctts', 0);
  w.u32(runs.length);
  for (const r of runs) {
    w.u32(r.count);
    w.u32(r.offset);
  }
  endBox(w, off);
}

function writeStsz(w, sizes) {
  const off = fullBox(w, 'stsz');
  w.u32(0);
  w.u32(sizes.length);
  for (const s of sizes) w.u32(s);
  endBox(w, off);
}

/** 一个样本一个 chunk，stsc 只有一条记录。返回 stco 数据区在 Writer 里的偏移，稍后回填。 */
function writeStblTables(w, { sizes, deltas, ctsOffsets, syncIndices, chunkOffsets }) {
  const off = fullBox(w, 'stts');
  {
    const runs = [];
    for (const d of deltas) {
      const last = runs[runs.length - 1];
      if (last && last.delta === d) last.count++;
      else runs.push({ count: 1, delta: d });
    }
    w.u32(runs.length);
    for (const r of runs) {
      w.u32(r.count);
      w.u32(r.delta);
    }
  }
  endBox(w, off);

  if (ctsOffsets) writeCtts(w, ctsOffsets);

  if (syncIndices && syncIndices.length && syncIndices.length < sizes.length) {
    const o = fullBox(w, 'stss');
    w.u32(syncIndices.length);
    for (const i of syncIndices) w.u32(i + 1);
    endBox(w, o);
  }

  const stscOff = fullBox(w, 'stsc');
  w.u32(1);
  w.u32(1);
  w.u32(1);
  w.u32(1);
  endBox(w, stscOff);

  writeStsz(w, sizes);

  let useCo64 = false;
  for (const o of chunkOffsets) {
    if (o > 0xffffffff) {
      useCo64 = true;
      break;
    }
  }
  const stcoOff = fullBox(w, useCo64 ? 'co64' : 'stco');
  w.u32(chunkOffsets.length);
  const entriesOff = w.len;
  for (const o of chunkOffsets) {
    if (useCo64) w.u64(o);
    else w.u32(o);
  }
  endBox(w, stcoOff);
  return { entriesOff, useCo64 };
}

function writeStsdVideo(w, { avcC, width, height }) {
  const off = fullBox(w, 'stsd');
  w.u32(1);
  const entryOff = beginBox(w, 'avc1');
  w.zeros(6);
  w.u16(1);
  w.u16(0);
  w.u16(0);
  w.u32(0);
  w.u32(0);
  w.u32(0);
  w.u16(width);
  w.u16(height);
  w.u32(0x00480000);
  w.u32(0x00480000);
  w.u32(0);
  w.u16(1);
  w.zeros(32);
  w.u16(0x0018);
  w.u16(0xffff);
  const avcCOff = beginBox(w, 'avcC');
  w.bytes(avcC);
  endBox(w, avcCOff);
  endBox(w, entryOff);
  endBox(w, off);
}

function writeStsdAudio(w, track) {
  const off = fullBox(w, 'stsd');
  w.u32(1);
  const entryOff = beginBox(w, 'mp4a');
  w.zeros(6);
  w.u16(1);
  w.u16(0);
  w.u16(0);
  w.u32(0);
  w.u16(track.channels);
  w.u16(16);
  w.u16(0);
  w.u16(0);
  w.u32(track.sampleRate << 16);
  const esdsOff = beginBox(w, 'esds');
  w.bytes(track.esds);
  endBox(w, esdsOff);
  endBox(w, entryOff);
  endBox(w, off);
}

function writeTrack(w, track, { trackId, movieTimescale, fixups }) {
  const trakOff = beginBox(w, 'trak');

  const tkhdOff = fullBox(w, 'tkhd', 0, 0x000007);
  w.u32(0);
  w.u32(0);
  w.u32(trackId);
  w.u32(0);
  w.u32(Math.round((track.duration / track.timescale) * movieTimescale));
  w.u32(0);
  w.u32(0);
  w.u16(0);
  w.u16(0);
  w.u16(track.kind === 'audio' ? 0x0100 : 0);
  w.u16(0);
  writeMatrix(w);
  w.u32(track.kind === 'video' ? track.width * 65536 : 0);
  w.u32(track.kind === 'video' ? track.height * 65536 : 0);
  endBox(w, tkhdOff);

  const mdiaOff = beginBox(w, 'mdia');
  const mdhdOff = fullBox(w, 'mdhd');
  w.u32(0);
  w.u32(0);
  w.u32(track.timescale);
  w.u32(track.duration);
  w.u16(0x55c4);
  w.u16(0);
  endBox(w, mdhdOff);

  const hdlrOff = fullBox(w, 'hdlr');
  w.u32(0);
  w.ascii(track.kind === 'video' ? 'vide' : 'soun');
  w.u32(0);
  w.u32(0);
  w.u32(0);
  w.bytes(new TextEncoder().encode(track.kind === 'video' ? 'VideoHandler' : 'SoundHandler'));
  w.u8(0);
  endBox(w, hdlrOff);

  const minfOff = beginBox(w, 'minf');
  if (track.kind === 'video') {
    const vmhdOff = fullBox(w, 'vmhd', 0, 1);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    endBox(w, vmhdOff);
  } else {
    const smhdOff = fullBox(w, 'smhd');
    w.u16(0);
    w.u16(0);
    endBox(w, smhdOff);
  }
  const dinfOff = beginBox(w, 'dinf');
  const drefOff = fullBox(w, 'dref');
  w.u32(1);
  const urlOff = fullBox(w, 'url ', 0, 1);
  endBox(w, urlOff);
  endBox(w, drefOff);
  endBox(w, dinfOff);

  const stblOff = beginBox(w, 'stbl');
  if (track.kind === 'video') writeStsdVideo(w, track);
  else writeStsdAudio(w, track);
  const info = writeStblTables(w, {
    sizes: track.sizes,
    deltas: track.deltas,
    ctsOffsets: track.ctsOffsets,
    syncIndices: track.syncIndices,
    chunkOffsets: track.chunkOffsets,
  });
  endBox(w, stblOff);
  endBox(w, minfOff);
  endBox(w, mdiaOff);
  endBox(w, trakOff);

  fixups.push({ track, entriesOff: info.entriesOff, useCo64: info.useCo64 });
}

// ---------------------------------------------------------------- 样本模型

function avcSampleSize(sample) {
  let size = 0;
  for (const nal of sample.nals) size += 4 + nal.length;
  return size;
}

function writeAvcSample(out, pos, sample) {
  let p = pos;
  for (const nal of sample.nals) {
    const n = nal.length;
    out[p] = (n >>> 24) & 0xff;
    out[p + 1] = (n >>> 16) & 0xff;
    out[p + 2] = (n >>> 8) & 0xff;
    out[p + 3] = n & 0xff;
    p += 4;
    out.set(nal, p);
    p += n;
  }
  return p;
}

/** 统一成 {kind, sizes, deltas, ctsOffsets, syncIndices, samples:[{nals}|{data}]} */
function finalizeTrack(t) {
  const sizes = [];
  const kept = [];
  const deltas = [];
  const ctsOffsets = t.ctsOffsets ? [] : null;
  const syncIndices = [];
  let allSync = true;

  for (let i = 0; i < t.samples.length; i++) {
    const s = t.samples[i];
    const size = s.nals ? avcSampleSize(s) : s.data.length;
    if (!size) continue;
    kept.push(s);
    sizes.push(size);
    deltas.push(t.deltas[i]);
    if (ctsOffsets) ctsOffsets.push(t.ctsOffsets[i]);
    if (s.nals) {
      let isSync = false;
      for (const nal of s.nals) {
        if ((nal[0] & 0x1f) === 5) isSync = true;
      }
      if (isSync) syncIndices.push(kept.length - 1);
      else allSync = false;
    }
  }

  const duration = deltas.reduce((a, b) => a + b, 0);
  return {
    ...t,
    samples: kept,
    sizes,
    deltas,
    ctsOffsets,
    syncIndices: !ctsOffsets ? null : allSync ? null : syncIndices.length ? syncIndices : [0],
    duration: t.fixedDuration != null ? t.fixedDuration : duration,
  };
}

// ---------------------------------------------------------------- 对外入口

/**
 * 把 TS / ADTS / MP3 字节流重新封装成 MP4。
 * @returns {Promise<{data:Uint8Array, ext:string, mime:string, videoCodec:string, audioCodec:string,
 *                    width:number, height:number, duration:number, warnings:string[]}>}
 */
export async function remuxToMp4(data, opts = {}) {
  const warnings = [];
  const container = probeContainer(data);
  let tracks;

  if (container === 'ts') {
    tracks = await demuxTsToTracks(data, warnings);
  } else if (container === 'adts') {
    tracks = [buildAdtsTrack(data, warnings)].filter(Boolean);
  } else if (container === 'mp3') {
    tracks = [buildMp3TrackFromEs(data, warnings)].filter(Boolean);
  } else if (container === 'fmp4') {
    return {
      data,
      ext: '.mp4',
      mime: 'video/mp4',
      videoCodec: '',
      audioCodec: '',
      width: 0,
      height: 0,
      duration: 0,
      warnings: ['输入本身已是 fMP4，已直接拼接'],
    };
  } else {
    throw new Error('无法识别的容器：' + container);
  }

  const list = tracks.filter((t) => t && t.samples.length).map(finalizeTrack);
  if (!list.length) throw new Error('没有解析出任何可用的音视频样本');

  // mdat 排布：先视频后音频。chunkOffsets 必须是“轨内相对偏移”，
  // 跨轨的累加放在回填那一步统一做，否则第二轨会被多加一次前面所有轨的大小。
  for (const t of list) {
    t.chunkOffsets = new Array(t.samples.length);
    let local = 0;
    for (let i = 0; i < t.samples.length; i++) {
      t.chunkOffsets[i] = local;
      local += t.sizes[i];
    }
    t.totalBytes = local;
  }
  let mdatPayloadLength = 0;
  for (const t of list) mdatPayloadLength += t.totalBytes;

  const ftyp = new Writer(32);
  {
    const off = beginBox(ftyp, 'ftyp');
    ftyp.ascii('isom');
    ftyp.u32(512);
    ftyp.ascii('isom');
    ftyp.ascii('iso2');
    if (list.some((t) => t.kind === 'video')) ftyp.ascii('avc1');
    ftyp.ascii('mp41');
    endBox(ftyp, off);
  }
  const ftypBytes = ftyp.out();

  const movieTimescale = 1000;
  let maxDurationMs = 0;
  for (const t of list) maxDurationMs = Math.max(maxDurationMs, (t.duration / t.timescale) * 1000);

  const moov = new Writer(4096);
  const fixups = [];
  {
    const moovOff = beginBox(moov, 'moov');
    const mvhdOff = fullBox(moov, 'mvhd');
    moov.u32(0);
    moov.u32(0);
    moov.u32(movieTimescale);
    moov.u32(Math.round(maxDurationMs));
    moov.u32(0x00010000);
    moov.u16(0x0100);
    moov.u16(0);
    moov.u32(0);
    moov.u32(0);
    writeMatrix(moov);
    moov.zeros(24);
    moov.u32(list.length + 1);
    endBox(moov, mvhdOff);

    let trackId = 1;
    for (const t of list) {
      writeTrack(moov, t, { trackId: trackId++, movieTimescale, fixups });
    }
    endBox(moov, moovOff);
  }
  const moovLen = moov.len;
  const mdatDataOffset = ftypBytes.length + moovLen + 8;

  // 回填 stco/co64
  let base = mdatDataOffset;
  for (const t of list) {
    const fix = fixups.find((f) => f.track === t);
    if (fix) {
      for (let i = 0; i < t.chunkOffsets.length; i++) {
        const abs = base + t.chunkOffsets[i];
        if (fix.useCo64) moov.patchU64(fix.entriesOff + i * 8, abs);
        else moov.patchU32(fix.entriesOff + i * 4, abs);
      }
    }
    base += t.totalBytes;
  }

  const total = mdatDataOffset + mdatPayloadLength;
  const out = new Uint8Array(total);
  out.set(ftypBytes, 0);
  out.set(moov.out(), ftypBytes.length);
  const mdatOff = ftypBytes.length + moovLen;
  const mdatSize = mdatPayloadLength + 8;
  out[mdatOff] = (mdatSize >>> 24) & 0xff;
  out[mdatOff + 1] = (mdatSize >>> 16) & 0xff;
  out[mdatOff + 2] = (mdatSize >>> 8) & 0xff;
  out[mdatOff + 3] = mdatSize & 0xff;
  out[mdatOff + 4] = 0x6d;
  out[mdatOff + 5] = 0x64;
  out[mdatOff + 6] = 0x61;
  out[mdatOff + 7] = 0x74;

  let writePos = mdatDataOffset;
  for (const t of list) {
    for (const s of t.samples) {
      if (s.nals) writePos = writeAvcSample(out, writePos, s);
      else {
        out.set(s.data, writePos);
        writePos += s.data.length;
      }
    }
  }

  const video = list.find((t) => t.kind === 'video');
  const audio = list.find((t) => t.kind === 'audio');
  return {
    data: out,
    ext: video ? '.mp4' : '.m4a',
    mime: video ? 'video/mp4' : 'audio/mp4',
    videoCodec: video ? video.codec : '',
    audioCodec: audio ? audio.codec : '',
    width: video ? video.width : 0,
    height: video ? video.height : 0,
    duration: Math.max(...list.map((t) => t.duration / t.timescale)),
    warnings,
  };
}

async function demuxTsToTracks(data, warnings) {
  const syncOffset = findSyncOffset(data);
  if (syncOffset < 0) throw new Error('找不到 TS 同步头');
  const { streams } = findStreams(data, syncOffset);
  if (!streams.length) throw new Error('TS 里没有找到节目信息表（PMT）');

  const videoStream = streams.find((s) => VIDEO_STREAM_TYPES.has(s.streamType));
  const audioStream = streams.find((s) => AUDIO_STREAM_TYPES.has(s.streamType));
  if (!videoStream && !audioStream) throw new Error('TS 里没有找到可用的音视频流');

  const esPids = new Set();
  if (videoStream) esPids.add(videoStream.pid);
  if (audioStream) esPids.add(audioStream.pid);

  const pesMap = new Map();
  for (const pid of esPids) pesMap.set(pid, []);
  const pending = new Map();

  const flush = (pid) => {
    const p = pending.get(pid);
    pending.delete(pid);
    if (p && p.chunks.length) pesMap.get(pid).push(p);
  };

  let count = 0;
  for (const pk of eachPacket(data, syncOffset)) {
    const pid = pk.pid;
    if (!esPids.has(pid)) continue;
    if ((count++ & 16383) === 0) {
      // 让出主线程，避免手机上长时间无响应
      await new Promise((r) => setTimeout(r, 0));
    }
    if (pk.pusi) {
      flush(pid);
      const payload = pk.payload;
      let pts = null;
      let dts = null;
      let startAt = 0;
      if (payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        const flags2 = payload[7];
        const hdrLen = payload[8];
        if (flags2 & 0x80) {
          pts = readPts(payload, 9);
          dts = flags2 & 0x40 ? readPts(payload, 14) : pts;
        }
        startAt = Math.min(9 + hdrLen, payload.length);
      }
      pending.set(pid, { pts, dts, chunks: [payload.subarray(startAt)] });
    } else if (pending.has(pid)) {
      pending.get(pid).chunks.push(pk.payload);
    }
  }
  for (const pid of esPids) flush(pid);

  const tracks = [];

  if (videoStream) {
    const pesUnits = pesMap.get(videoStream.pid) || [];
    if (videoStream.streamType === 0x24) {
      warnings.push('检测到 H.265/HEVC 视频轨，暂不支持转封装，已跳过视频轨');
    } else {
      const { samples, sps, pps } = buildAvcSamples(pesUnits);
      if (samples.length && sps && pps) {
        const track = buildVideoTrack(samples, sps, pps, warnings);
        if (track) tracks.push(track);
      } else if (samples.length) {
        warnings.push('没找到 SPS/PPS，无法生成 avcC，已跳过视频轨');
      }
    }
  }

  if (audioStream) {
    const pesUnits = pesMap.get(audioStream.pid) || [];
    let es;
    if (pesUnits.length === 1) es = pesUnits[0].chunks[0];
    else {
      const chunks = [];
      for (const p of pesUnits) for (const c of p.chunks) chunks.push(c);
      es = concatUint8(chunks);
    }
    if (audioStream.streamType === 0x0f) {
      const { frames, sampleRate, channels, profile } = parseAdts(es);
      if (frames.length) tracks.push(buildAacTrack(frames, sampleRate, channels, profile));
      else warnings.push('音频轨没有解出 AAC 帧');
    } else if (audioStream.streamType === 0x03 || audioStream.streamType === 0x04) {
      const { frames, sampleRate, channels, samplesPerFrame, version } = parseMp3(es);
      if (frames.length) tracks.push(buildMp3Track(frames, sampleRate, channels, samplesPerFrame, version));
      else warnings.push('音频轨没有解出 MP3 帧');
    } else {
      warnings.push(`不支持的音频流类型 0x${audioStream.streamType.toString(16)}`);
    }
  }

  return tracks;
}

function buildVideoTrack(samples, sps, pps, warnings) {
  const { width, height } = parseSpsDimensions(sps);
  if (!width) warnings.push('未能从 SPS 解析出分辨率，tkhd 里按 0 写入（一般不影响播放）');

  const dtsList = [];
  const ptsList = [];
  let fallback = 3000;

  for (const s of samples) {
    let dts = s.dts != null ? s.dts : s.pts != null ? s.pts : null;
    let pts = s.pts != null ? s.pts : dts;
    if (dts == null) {
      dts = dtsList.length ? dtsList[dtsList.length - 1] + fallback : 0;
      pts = dts;
    }
    if (dtsList.length) {
      const prev = dtsList[dtsList.length - 1];
      let delta = dts - prev;
      // 时间戳回绕或断点会造出离谱的间隔，按上一帧的间隔兜底
      if (delta <= 0 || delta > 900000) {
        const prevDelta = dtsList.length > 1 ? dtsList[dtsList.length - 1] - dtsList[dtsList.length - 2] : fallback;
        delta = prevDelta > 0 && prevDelta <= 900000 ? prevDelta : fallback;
        dts = prev + delta;
      }
      fallback = delta;
    }
    if (pts < dts) pts = dts;
    dtsList.push(dts);
    ptsList.push(pts);
  }

  // 先整体平移到 0，再算相邻间隔。两件事必须在两个循环里做，
  // 否则 dtsList[i+1] 还没平移、dtsList[i] 已经平移，每帧间隔会平白多出一个起始 PTS。
  const t0 = dtsList[0];
  for (let i = 0; i < dtsList.length; i++) {
    dtsList[i] -= t0;
    ptsList[i] -= t0;
  }
  const deltas = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    deltas[i] = i + 1 < samples.length ? dtsList[i + 1] - dtsList[i] : i > 0 ? dtsList[i] - dtsList[i - 1] : fallback;
  }
  const ctsOffsets = new Array(samples.length);
  let minCts = 0;
  for (let i = 0; i < samples.length; i++) {
    ctsOffsets[i] = ptsList[i] - dtsList[i];
    if (ctsOffsets[i] < minCts) minCts = ctsOffsets[i];
  }
  if (minCts < 0) for (let i = 0; i < ctsOffsets.length; i++) ctsOffsets[i] -= minCts;

  return {
    kind: 'video',
    codec: 'avc1',
    timescale: 90000,
    width,
    height,
    avcC: buildAvcC(sps, pps),
    samples: samples.map((s) => ({ nals: s.nals })),
    deltas,
    ctsOffsets,
  };
}

function buildAacTrack(frames, sampleRate, channels, profile) {
  const aot = Math.min(Math.max(profile + 1, 1), 4);
  const sfIndex = Math.max(0, ADTS_SAMPLE_RATES.indexOf(sampleRate));
  const asc = new Uint8Array(2);
  asc[0] = ((aot & 0x1f) << 3) | ((sfIndex >> 1) & 0x07);
  asc[1] = ((sfIndex & 1) << 7) | ((channels & 0x0f) << 3);
  return {
    kind: 'audio',
    codec: 'aac',
    timescale: sampleRate,
    channels,
    sampleRate,
    esds: buildEsds(0x40, asc, 128000),
    samples: frames.map((f) => ({ data: f })),
    deltas: new Array(frames.length).fill(1024),
    ctsOffsets: null,
    fixedDuration: frames.length * 1024,
  };
}

function buildMp3Track(frames, sampleRate, channels, samplesPerFrame, version) {
  return {
    kind: 'audio',
    codec: 'mp3',
    timescale: sampleRate,
    channels,
    sampleRate,
    esds: buildEsds(version === 3 ? 0x6b : 0x69, null, 128000),
    samples: frames.map((f) => ({ data: f })),
    deltas: new Array(frames.length).fill(samplesPerFrame),
    ctsOffsets: null,
    fixedDuration: frames.length * samplesPerFrame,
  };
}

function buildAdtsTrack(data, warnings) {
  const { frames, sampleRate, channels, profile, skipped } = parseAdts(data);
  if (!frames.length) {
    warnings.push('没有解出 AAC 帧');
    return null;
  }
  if (skipped > frames.length) warnings.push('ADTS 流里有较多无法识别的字节，已跳过');
  return buildAacTrack(frames, sampleRate, channels, profile);
}

function buildMp3TrackFromEs(data, warnings) {
  const { frames, sampleRate, channels, samplesPerFrame, version } = parseMp3(data);
  if (!frames.length) {
    warnings.push('没有解出 MP3 帧');
    return null;
  }
  return buildMp3Track(frames, sampleRate, channels, samplesPerFrame, version);
}
