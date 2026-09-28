// 判断一个 URL / Content-Type 属于哪类媒体。纯函数，便于单测。

import { urlExt, urlPath } from './util.js';

const AUDIO_EXT = new Set(['mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'ape', 'amr', 'weba', 'mp2', 'aiff', 'caf']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'avi', 'ts', 'm4s', '3gp', 'mpg', 'mpeg', 'ogv', 'wmv', 'f4v']);
const PLAYLIST_EXT = new Set(['m3u8', 'm3u']);
const DASH_EXT = new Set(['mpd']);

const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
  'vnd.apple.mpegurl',
]);

/**
 * @returns {{kind:'hls'|'dash'|'audio'|'video'|'playlist'|'unknown', ext:string, why:string}}
 */
export function classify({ url = '', contentType = '', contentDisposition = '' } = {}) {
  const ct = String(contentType).toLowerCase().split(';')[0].trim();
  const ext = urlExt(url);
  const path = urlPath(url).toLowerCase();

  // 1) Content-Type 最可靠
  if (HLS_TYPES.has(ct)) return { kind: 'hls', ext: '.m3u8', why: 'content-type' };
  if (ct === 'application/dash+xml') return { kind: 'dash', ext: '.mpd', why: 'content-type' };
  if (ct.startsWith('audio/')) {
    if (ct === 'audio/mpegurl' || ct === 'audio/x-mpegurl') return { kind: 'hls', ext: '.m3u8', why: 'content-type' };
    return { kind: 'audio', ext: '', why: 'content-type' };
  }
  if (ct.startsWith('video/')) {
    if (ct === 'video/mp2t') return { kind: 'video', ext: '.ts', why: 'content-type' };
    return { kind: 'video', ext: '', why: 'content-type' };
  }

  // 2) 扩展名
  if (PLAYLIST_EXT.has(ext)) return { kind: 'hls', ext: '.m3u8', why: 'ext' };
  if (DASH_EXT.has(ext)) return { kind: 'dash', ext: '.mpd', why: 'ext' };
  if (AUDIO_EXT.has(ext)) return { kind: 'audio', ext: '.' + ext, why: 'ext' };
  if (VIDEO_EXT.has(ext)) return { kind: 'video', ext: '.' + ext, why: 'ext' };

  // 3) 地址里带 m3u8 字样的（?format=m3u8、/hls/m3u8/xxx 之类）基本可以认定是播放列表
  if (/m3u8/i.test(String(url))) return { kind: 'hls', ext: '.m3u8', why: 'url-keyword' };

  // 4) 没有扩展名时看路径里有没有关键词
  if (/(^|[/_.-])(hls|master|index|playlist)([/_.-]|$)/.test(path) && ct === '') {
    return { kind: 'unknown', ext: '', why: 'weak-hls-hint' };
  }
  if (ct === 'application/octet-stream' || ct === '') {
    if (contentDisposition && /\.(mp4|mp3|m4a|flv|mkv|webm|ts)\b/i.test(contentDisposition)) {
      const e = /\.([a-z0-9]{2,5})\b/i.exec(contentDisposition);
      return { kind: VIDEO_EXT.has(e[1].toLowerCase()) ? 'video' : 'audio', ext: '.' + e[1].toLowerCase(), why: 'disposition' };
    }
  }
  return { kind: 'unknown', ext: '', why: '' };
}

export function isMediaKind(kind) {
  return kind === 'audio' || kind === 'video' || kind === 'hls' || kind === 'dash';
}

/**
 * 判断一个 URL 值不值得记下来。避免把图片、字体、CSS、埋点都塞进列表。
 * 返回 false 表示明确无关；返回 true 表示候选（后续还会用响应头再确认一次）。
 */
export function worthSniffing(url, { requestType = '' } = {}) {
  if (!url) return false;
  const u = String(url);
  if (u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('filesystem:')) return false;
  if (!/^https?:/i.test(u)) return false;
  const ext = urlExt(u);
  if (['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'map', 'json', 'html', 'htm', 'xml', 'txt'].includes(ext)) {
    // 但 ?file=x.mp4 这种偶尔也有，交给 contentType 兜底，这里先排除纯静态资源
    return false;
  }
  if (requestType === 'media' || requestType === 'object' || requestType === 'xmlhttprequest' || requestType === 'other' || requestType === '') {
    return true;
  }
  return false;
}

/**
 * 合并同一条媒体的多次观测结果。后来拿到的响应头/长度能补全早先只有 URL 的记录。
 */
export function mergeHit(prev, next) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'size' && !v) continue;
    out[k] = v;
  }
  // 分类结果以信息量更高的为准
  if (next.contentType && !prev.contentType) out.classified = next.classified;
  if (!out.classified && next.classified) out.classified = next.classified;
  if (prev.classified && next.classified) {
    const rank = (c) => (c.kind === 'hls' || c.kind === 'dash' ? 3 : c.kind === 'audio' || c.kind === 'video' ? 2 : 0);
    out.classified = rank(next.classified) > rank(prev.classified) ? next.classified : prev.classified;
  }
  return out;
}
