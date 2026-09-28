// 判断一个 URL / Content-Type 属于哪类媒体。纯函数，便于单测。

import { urlExt, urlPath } from './util.js';

const AUDIO_EXT = new Set(['mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'ape', 'amr', 'weba', 'mp2', 'aiff', 'caf']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'avi', 'ts', 'm4s', '3gp', 'mpg', 'mpeg', 'ogv', 'wmv', 'f4v']);
const PLAYLIST_EXT = new Set(['m3u8', 'm3u']);
const DASH_EXT = new Set(['mpd']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff']);

// 这些扩展名基本不可能是媒体，直接不看（图片单独判断，见 worthSniffing）
const NEVER_EXT = new Set(['js', 'mjs', 'css', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'map', 'json', 'html', 'htm', 'xml', 'txt', 'wasm', 'pdf']);

const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
  'vnd.apple.mpegurl',
]);

/**
 * @returns {{kind:'hls'|'dash'|'audio'|'video'|'image'|'playlist'|'unknown', ext:string, why:string}}
 */
export function classify({ url = '', contentType = '', contentDisposition = '' } = {}) {
  const ct = String(contentType).toLowerCase().split(';')[0].trim();
  const ext = urlExt(url);
  const path = urlPath(url).toLowerCase();

  // 1) Content-Type 最可靠
  if (HLS_TYPES.has(ct)) return { kind: 'hls', ext: '.m3u8', why: 'content-type' };
  if (ct === 'application/dash+xml') return { kind: 'dash', ext: '.mpd', why: 'content-type' };
  if (ct.startsWith('image/')) return { kind: 'image', ext: '', why: 'content-type' };
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
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ext: '.' + ext, why: 'ext' };
  if (AUDIO_EXT.has(ext)) return { kind: 'audio', ext: '.' + ext, why: 'ext' };
  if (VIDEO_EXT.has(ext)) return { kind: 'video', ext: '.' + ext, why: 'ext' };

  // 3) 地址里带 m3u8 字样的（?format=m3u8、/hls/m3u8/xxx 之类）基本可以认定是播放列表
  if (/m3u8/i.test(String(url))) return { kind: 'hls', ext: '.m3u8', why: 'url-keyword' };

  // 4) 没有扩展名时看路径里有没有关键词
  if (/(^|[/_.-])(hls|master|index|playlist)([/_.-]|$)/.test(path) && ct === '') {
    return { kind: 'unknown', ext: '', why: 'weak-hls-hint' };
  }
  if (ct === 'application/octet-stream' || ct === '') {
    if (contentDisposition && /\.(mp4|mp3|m4a|flv|mkv|webm|ts|jpg|png|webp)\b/i.test(contentDisposition)) {
      const e = /\.([a-z0-9]{2,5})\b/i.exec(contentDisposition);
      const kind = IMAGE_EXT.has(e[1].toLowerCase()) ? 'image' : VIDEO_EXT.has(e[1].toLowerCase()) ? 'video' : 'audio';
      return { kind, ext: '.' + e[1].toLowerCase(), why: 'disposition' };
    }
  }
  return { kind: 'unknown', ext: '', why: '' };
}

export function isMediaKind(kind) {
  return kind === 'audio' || kind === 'video' || kind === 'hls' || kind === 'dash';
}

export function isImageKind(kind) {
  return kind === 'image';
}

/**
 * 判断一个 URL 值不值得记下来。避免把脚本、字体、埋点都塞进列表。
 * 图片默认也收，但要求是「图片请求」本身，CSS/脚本里引用到的不算。
 */
export function worthSniffing(url, { requestType = '', images = true } = {}) {
  if (!url) return false;
  const u = String(url);
  if (u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('filesystem:')) return false;
  if (!/^https?:/i.test(u)) return false;
  const ext = urlExt(u);
  if (NEVER_EXT.has(ext)) return false;
  if (IMAGE_EXT.has(ext)) {
    if (!images) return false;
    // 只有真正作为图片/资源加载的才算，避免把 a[href] 里的图标地址当图片
    return requestType === 'image' || requestType === 'xmlhttprequest' || requestType === 'other' || requestType === '';
  }
  if (requestType === 'media' || requestType === 'object' || requestType === 'xmlhttprequest' || requestType === 'other' || requestType === '') {
    return true;
  }
  // 经 fetch/XHR 拿到的图片或媒体，requestType 会是 image
  if (requestType === 'image') return true;
  return false;
}

/** Content-Type 是不是图片，用于只有响应头没有扩展名的场景。 */
export function isImageContentType(contentType) {
  return String(contentType).toLowerCase().split(';')[0].trim().startsWith('image/');
}

/** 小于这个体积的图片多半是图标、分隔线、埋点像素，默认折叠起来。 */
export const TINY_IMAGE_BYTES = 2048;


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
