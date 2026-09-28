// HLS(m3u8) 播放列表解析与分片下载。不依赖浏览器 API，Node 里可直接测试。

import { resolveUrl, retry, orderedPool } from './util.js';
import { decryptAes128, sequenceToIv, parseHexIv } from './aes.js';

/**
 * 解析 #EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="a,b" 这类属性串。
 * 需要正确处理引号里的逗号，所以不能简单 split(',')。
 */
export function parseAttributes(str) {
  const out = {};
  let i = 0;
  const s = String(str || '');
  while (i < s.length) {
    while (i < s.length && (s[i] === ',' || s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    const eq = s.indexOf('=', i);
    if (eq === -1) break;
    const key = s.slice(i, eq).trim();
    i = eq + 1;
    let val = '';
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end === -1) {
        val = s.slice(i + 1);
        i = s.length;
      } else {
        val = s.slice(i + 1, end);
        i = end + 1;
      }
    } else {
      let end = s.indexOf(',', i);
      if (end === -1) end = s.length;
      val = s.slice(i, end).trim();
      i = end;
    }
    if (key) out[key] = val;
  }
  return out;
}

export function pickBestVariant(variants) {
  const usable = variants.filter((v) => !v.iframe && v.url);
  if (!usable.length) return variants.find((v) => v.url) || null;
  const score = (v) => {
    let s = v.bandwidth || v.averageBandwidth || 0;
    if (v.resolution) {
      const m = /^(\d+)x(\d+)$/.exec(v.resolution);
      if (m) s = Math.max(s, Number(m[1]) * Number(m[2]));
    }
    return s;
  };
  return usable.slice().sort((a, b) => score(b) - score(a))[0];
}

export function pickLowestVariant(variants) {
  const usable = variants.filter((v) => !v.iframe && v.url);
  if (!usable.length) return variants.find((v) => v.url) || null;
  const score = (v) => v.bandwidth || v.averageBandwidth || 0;
  return usable.slice().sort((a, b) => score(a) - score(b))[0];
}

/** 给清晰度起个手机上看得懂的名字。 */
export function variantLabel(v, index) {
  const parts = [];
  const m = /^(\d+)x(\d+)$/.exec(v.resolution || '');
  if (m) parts.push(`${m[2]}p`);
  else if (v.bandwidth) parts.push(`${Math.round(v.bandwidth / 1000)}kbps`);
  if (m && v.bandwidth) parts.push(`${(v.bandwidth / 1000000).toFixed(1)}Mbps`);
  if (v.frameRate) parts.push(`${Math.round(v.frameRate)}fps`);
  const codec = (v.codecs || '').toLowerCase();
  if (codec.includes('hvc1') || codec.includes('hev1')) parts.push('H.265');
  else if (codec.includes('av01')) parts.push('AV1');
  else if (codec.includes('avc1')) parts.push('H.264');
  if (codec.includes('mp4a')) parts.push('AAC');
  if (!parts.length) parts.push(v.name || `清晰度 ${index + 1}`);
  else if (v.name) parts.unshift(v.name);
  return parts.join(' · ');
}

/**
 * 解析播放列表文本。
 * @returns {{type:'master'|'media'|'unknown', variants:Array, renditions:Array, segments:Array,
 *            map:object|null, targetDuration:number, isLive:boolean, duration:number,
 *            hasDiscontinuity:boolean, encryption:object|null}}
 */
export function parsePlaylist(text, baseUrl = '') {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  const renditions = [];
  const segments = [];
  let map = null;
  let pendingVariant = null;
  let currentKey = null;
  let targetDuration = 0;
  let mediaSequence = 0;
  let isMaster = false;
  let hasEndList = false;
  let hasDiscontinuity = false;
  let duration = 0;
  let prevByteRangeEnd = -1;
  let prevByteRangeUri = null;
  let segIndex = 0;
  let pendingDuration = 0;
  let pendingByteRange = null;
  let pendingDiscontinuity = false;
  const methods = new Set();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const m = /^#([A-Za-z0-9-]+)(?::(.*))?$/.exec(line);
      if (!m) continue;
      const tag = m[1].toUpperCase();
      const body = m[2] == null ? '' : m[2];

      if (tag === 'EXT-X-STREAM-INF') {
        isMaster = true;
        const a = parseAttributes(body);
        pendingVariant = {
          url: '',
          bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : 0,
          averageBandwidth: a['AVERAGE-BANDWIDTH'] ? Number(a['AVERAGE-BANDWIDTH']) : 0,
          resolution: a.RESOLUTION || '',
          codecs: a.CODECS || '',
          frameRate: a['FRAME-RATE'] ? Number(a['FRAME-RATE']) : 0,
          name: a.NAME || '',
          audioGroup: a.AUDIO || '',
          iframe: false,
        };
      } else if (tag === 'EXT-X-I-FRAME-STREAM-INF') {
        isMaster = true;
        const a = parseAttributes(body);
        if (a.URI) {
          variants.push({
            url: resolveUrl(baseUrl, a.URI),
            bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : 0,
            averageBandwidth: 0,
            resolution: a.RESOLUTION || '',
            codecs: a.CODECS || '',
            frameRate: 0,
            name: '仅关键帧',
            audioGroup: '',
            iframe: true,
          });
        }
      } else if (tag === 'EXT-X-MEDIA') {
        const a = parseAttributes(body);
        renditions.push({
          type: a.TYPE || '',
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          autoselect: a.AUTOSELECT === 'YES',
          channels: a.CHANNELS || '',
          url: a.URI ? resolveUrl(baseUrl, a.URI) : '',
        });
      } else if (tag === 'EXTINF') {
        pendingDuration = parseFloat(String(body).split(',')[0]) || 0;
      } else if (tag === 'EXT-X-BYTERANGE') {
        const [len, off] = String(body).split('@');
        pendingByteRange = { length: Number(len), offset: off === undefined ? null : Number(off) };
      } else if (tag === 'EXT-X-KEY') {
        const a = parseAttributes(body);
        if (!a.METHOD || a.METHOD.toUpperCase() === 'NONE') {
          currentKey = null;
        } else {
          currentKey = {
            method: a.METHOD.toUpperCase(),
            uri: a.URI ? resolveUrl(baseUrl, a.URI) : '',
            iv: parseHexIv(a.IV),
            keyFormat: a.KEYFORMAT || 'identity',
            keyFormatVersions: a.KEYFORMATVERSIONS || '',
          };
          methods.add(currentKey.method);
        }
      } else if (tag === 'EXT-X-MAP') {
        const a = parseAttributes(body);
        let br = null;
        if (a.BYTERANGE) {
          const [l, o] = String(a.BYTERANGE).split('@');
          br = { length: Number(l), offset: o === undefined ? 0 : Number(o) };
        }
        map = { url: resolveUrl(baseUrl, a.URI), byteRange: br };
      } else if (tag === 'EXT-X-TARGETDURATION') {
        targetDuration = Number(body) || 0;
      } else if (tag === 'EXT-X-MEDIA-SEQUENCE') {
        mediaSequence = Number(body) || 0;
      } else if (tag === 'EXT-X-DISCONTINUITY') {
        pendingDiscontinuity = true;
        hasDiscontinuity = true;
      } else if (tag === 'EXT-X-ENDLIST') {
        hasEndList = true;
      }
      continue;
    }

    // 非 # 开头 => URI 行
    if (pendingVariant) {
      pendingVariant.url = resolveUrl(baseUrl, line);
      variants.push(pendingVariant);
      pendingVariant = null;
      continue;
    }

    const uri = resolveUrl(baseUrl, line);
    let byteRange = pendingByteRange;
    if (byteRange && byteRange.offset == null) {
      if (prevByteRangeUri === uri && prevByteRangeEnd >= 0) {
        byteRange = { length: byteRange.length, offset: prevByteRangeEnd };
      } else {
        byteRange = { length: byteRange.length, offset: 0 };
      }
    }
    // 个别播放列表会漏写 EXTINF，缺了就按 TARGETDURATION 估一个
    const segDuration = pendingDuration || targetDuration;
    segments.push({
      index: segIndex,
      url: uri,
      duration: segDuration,
      byteRange,
      key: currentKey,
      discontinuity: pendingDiscontinuity,
      seq: mediaSequence + segIndex,
      map,
    });
    duration += segDuration;
    if (byteRange) {
      prevByteRangeUri = uri;
      prevByteRangeEnd = byteRange.offset + byteRange.length;
    }
    pendingDuration = 0;
    pendingByteRange = null;
    pendingDiscontinuity = false;
    segIndex++;
  }

  const type = isMaster || variants.length ? 'master' : segments.length ? 'media' : 'unknown';
  const encryption = methods.size
    ? { methods: [...methods], method: methods.has('AES-128') ? 'AES-128' : [...methods][0] }
    : null;

  return {
    type,
    variants,
    renditions,
    segments,
    map,
    targetDuration,
    isLive: type === 'media' && !hasEndList,
    duration,
    hasDiscontinuity,
    encryption,
    mediaSequence,
  };
}

function makeFetcher({ fetchImpl, referrer, credentials, extraHeaders, retries }) {
  return async function get(url, { range = null, signal = null } = {}) {
    const headers = { ...(extraHeaders || {}) };
    if (range) headers['Range'] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const init = { method: 'GET', headers, credentials: credentials || 'include', redirect: 'follow' };
    if (referrer) {
      init.referrer = referrer;
      init.referrerPolicy = 'unsafe-url';
    }
    if (signal) init.signal = signal;
    const res = await fetchImpl(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''} - ${url}`.trim());
    return res;
  };
}

async function readBody(res, range) {
  const buf = new Uint8Array(await res.arrayBuffer());
  // 有些服务器忽略 Range 直接返回整段，这里补一次裁剪
  if (range && res.status === 200 && buf.length >= range.offset + range.length) {
    return buf.subarray(range.offset, range.offset + range.length);
  }
  return buf;
}

/**
 * 只读播放列表，不下分片。用于在界面上给用户列清晰度。
 */
export async function probeHls(options) {
  const { url, fetchImpl = globalThis.fetch, referrer = '', credentials = 'include', headers = {}, retries = 2 } = options || {};
  const get = makeFetcher({ fetchImpl, referrer, credentials, extraHeaders: headers, retries });
  const text = await retry(async () => (await get(url)).text(), { retries });
  let info = parsePlaylist(text, url);
  const result = {
    url,
    type: info.type,
    isLive: info.isLive,
    duration: info.duration,
    segmentCount: info.segments.length,
    segmentDuration: info.targetDuration,
    hasDiscontinuity: info.hasDiscontinuity,
    encryption: info.encryption,
    renditions: info.renditions,
    variants: [],
    container: '',
  };
  if (info.type === 'master') {
    result.variants = info.variants.map((v, i) => ({
      index: i,
      url: v.url,
      bandwidth: v.bandwidth || v.averageBandwidth,
      resolution: v.resolution,
      codecs: v.codecs,
      frameRate: v.frameRate,
      iframe: v.iframe,
      label: variantLabel(v, i),
    }));
    const audioOnly = result.variants.length > 0 && result.variants.every((v) => !v.resolution && /mp4a|aac|opus/i.test(v.codecs) && !/avc1|hvc1|hev1|av01|vp0?9/i.test(v.codecs));
    result.audioOnly = audioOnly;
  } else {
    result.audioOnly = info.map ? false : false;
    result.segmentsAreFmp4 = !!info.map;
  }
  return result;
}

/**
 * 下载一条 HLS 流。分片按顺序、并发抓取，边下边通过 onData 交给调用方。
 * @param {object} options
 * @param {string} options.url 播放列表地址（master 或 media 都行）
 * @param {Function} options.onData (Uint8Array, meta) => void|Promise 按顺序吐数据
 * @param {Function} [options.selectVariant] 拿到 variants 后决定用哪个
 */
export async function downloadHls(options) {
  const {
    url,
    fetchImpl = globalThis.fetch,
    referrer = '',
    credentials = 'include',
    headers: extraHeaders = {},
    concurrency = 4,
    retries = 3,
    signal = null,
    selectVariant = null,
    onData,
    onProgress = null,
    cryptoImpl = globalThis.crypto,
    maxSegments = 200000,
    maxBytes = 0,
  } = options || {};

  if (typeof onData !== 'function') throw new Error('downloadHls 需要 onData 回调');
  const get = makeFetcher({ fetchImpl, referrer, credentials, extraHeaders, retries });

  let playlistUrl = url;
  let text = await retry(async () => (await get(playlistUrl)).text(), { retries });
  let info = parsePlaylist(text, playlistUrl);
  let chosenVariant = null;

  if (info.type === 'master') {
    const usable = info.variants.filter((v) => v.url && !v.iframe);
    if (!usable.length) throw new Error('主播放列表里没有可用的清晰度');
    chosenVariant = selectVariant ? await selectVariant(usable, info) : pickBestVariant(usable);
    if (!chosenVariant || !chosenVariant.url) throw new Error('没有选择清晰度');
    playlistUrl = chosenVariant.url;
    text = await retry(async () => (await get(playlistUrl)).text(), { retries });
    const inner = parsePlaylist(text, playlistUrl);
    if (inner.type === 'master') throw new Error('播放列表嵌套了多层 master，暂不支持');
    info = inner;
  }

  if (info.type !== 'media') throw new Error('这不是一个有效的 m3u8 播放列表');
  const segments = info.segments;
  if (!segments.length) throw new Error('播放列表里没有分片');

  if (segments.length > maxSegments) {
    throw new Error(`分片数量过多（${segments.length}），可能是直播流或异常列表，已停止`);
  }

  const unsupported = new Set();
  for (const seg of segments) {
    if (!seg.key) continue;
    if (seg.key.keyFormat && seg.key.keyFormat !== 'identity') {
      throw new Error(`该流使用 ${seg.key.keyFormat} 加密（DRM），浏览器无法解密`);
    }
    if (seg.key.method !== 'AES-128') unsupported.add(seg.key.method);
  }
  if (unsupported.size) {
    throw new Error(`暂不支持的加密方式：${[...unsupported].join(', ')}`);
  }

  const keyCache = new Map();
  async function getKey(key) {
    if (keyCache.has(key.uri)) return keyCache.get(key.uri);
    const p = retry(
      async () => {
        const res = await get(key.uri);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length !== 16) throw new Error(`密钥长度异常：${bytes.length} 字节`);
        return bytes;
      },
      { retries }
    );
    keyCache.set(key.uri, p);
    return p;
  }

  let received = 0;
  let done = 0;
  let aborted = false;

  const emit = async (bytes, meta) => {
    received += bytes.length;
    if (maxBytes && received > maxBytes) {
      aborted = true;
      throw new Error(`已超过设定的大小上限（${maxBytes} 字节）`);
    }
    await onData(bytes, meta);
  };

  if (info.map && info.map.url) {
    const bytes = await retry(async () => readBody(await get(info.map.url, { range: info.map.byteRange }), info.map.byteRange), { retries });
    await emit(bytes, { kind: 'init', index: -1, url: info.map.url, discontinuity: false });
  }

  try {
    await orderedPool(
      segments,
      async (seg) => {
        return retry(
          async () => {
            const res = await get(seg.url, { range: seg.byteRange, signal });
            let bytes = await readBody(res, seg.byteRange);
            if (seg.key && seg.key.method === 'AES-128') {
              const kb = await getKey(seg.key);
              const iv = seg.key.iv || sequenceToIv(seg.seq);
              bytes = await decryptAes128(bytes, kb, iv, cryptoImpl);
            }
            return bytes;
          },
          { retries }
        );
      },
      {
        concurrency,
        windowSize: concurrency + 2,
        onResult: async (bytes, idx) => {
          const seg = segments[idx];
          await emit(bytes, {
            kind: 'segment',
            index: idx,
            url: seg.url,
            discontinuity: seg.discontinuity,
          });
          done++;
          if (onProgress && (done % 3 === 0 || done === segments.length)) {
            await onProgress({
              done,
              total: segments.length,
              received,
              duration: info.duration,
              playlistUrl,
              isLive: info.isLive,
            });
          }
        },
      }
    );
  } catch (e) {
    if (aborted) throw e;
    throw new Error(`下载分片失败（已成功 ${done}/${segments.length}）：${e.message || e}`);
  }

  return {
    received,
    count: done,
    total: segments.length,
    duration: info.duration,
    isLive: info.isLive,
    hasDiscontinuity: info.hasDiscontinuity,
    hasMap: !!info.map,
    playlistUrl,
    variant: chosenVariant,
    encryption: info.encryption,
  };
}
