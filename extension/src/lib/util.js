// 通用工具：URL 处理、体积格式化、文件名推断、并发控制。
// 这个文件不依赖任何浏览器 API，可以在 Node 里直接跑测试。

export function resolveUrl(base, ref) {
  if (!ref) return base;
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

/** 取 URL 的路径部分（忽略查询串），用于判断扩展名。 */
export function urlPath(url) {
  try {
    return new URL(url).pathname || '';
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

export function urlExt(url) {
  const p = urlPath(url);
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

export function urlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 把 Content-Disposition 里的文件名抠出来。
 * 同时支持 filename*=UTF-8''%E4%B8%AD%E6%96%87.mp3 这种 RFC 5987 写法。
 */
export function filenameFromDisposition(cd) {
  if (!cd) return '';
  const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
  if (star) {
    let raw = star[1].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    const m = /^([\w-]+)'([\w-]*)'(.*)$/.exec(raw);
    if (m) {
      const charset = (m[1] || 'utf-8').toLowerCase();
      const rest = m[3];
      try {
        const bytes = Uint8Array.from(rest.split('').map((c) => c.charCodeAt(0)));
        if (charset === 'utf-8' || charset === 'utf8') {
          return decodeURIComponent(escape(String.fromCharCode(...bytes)));
        }
        return decodeURIComponent(rest);
      } catch {
        try {
          return decodeURIComponent(rest);
        } catch {
          return rest;
        }
      }
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
  if (plain) return (plain[1] || plain[2] || '').trim();
  return '';
}

const BAD_FS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 清掉文件名里操作系统不接受的字符，并限制长度。 */
export function sanitizeFilename(name, fallback = 'media') {
  let n = String(name || '').replace(BAD_FS, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!n) n = fallback;
  // 给扩展名留出空间，避免最后一位被截断
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    if (dot > 0 && n.length - dot <= 6) {
      n = n.slice(0, 120 - (n.length - dot)) + n.slice(dot);
    } else {
      n = n.slice(0, 120);
    }
  }
  return n;
}

/**
 * 由一个媒体 URL 推断保存用的文件名。
 * 显式给了 contentDisposition / 播放器标题时优先用它们。
 */
export function guessFilename({ url, contentType = '', contentDisposition = '', hint = '' } = {}) {
  const ext = urlExt(url);
  const fromCd = sanitizeFilename(filenameFromDisposition(contentDisposition), '');
  if (fromCd) return fromCd;

  let base = '';
  if (hint) {
    base = sanitizeFilename(hint, '');
  }
  if (!base) {
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      base = sanitizeFilename(decodeURIComponent(seg), 'media');
    } catch {
      base = 'media';
    }
  }
  // 去掉查询串造成的伪扩展名，例如 xxx.mp4?token=...
  base = base.replace(/\.(m3u8|mpd)$/i, '');
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
    const guess = extFromContentType(contentType) || (ext ? '.' + ext : '');
    if (guess) base += guess;
  }
  return base || 'media';
}

export function extFromContentType(ct = '') {
  const t = String(ct).toLowerCase().split(';')[0].trim();
  switch (t) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/aac':
      return '.m4a';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/opus':
      return '.opus';
    case 'audio/flac':
    case 'audio/x-flac':
      return '.flac';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'video/mp4':
      return '.mp4';
    case 'video/webm':
      return '.webm';
    case 'video/x-matroska':
      return '.mkv';
    case 'video/mp2t':
      return '.ts';
    case 'application/vnd.apple.mpegurl':
    case 'application/x-mpegurl':
    case 'audio/mpegurl':
    case 'audio/x-mpegurl':
      return '.m3u8';
    default:
      return '';
  }
}

export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/**
 * 按时长和声明码率估算体积。
 * HLS 的 BANDWIDTH 是站点自己声明的峰值码率，算出来通常比真实值略大一点，
 * 所以界面上要标「约」。
 */
export function estimateBytes(durationSec, bandwidthBps) {
  const d = Number(durationSec);
  const b = Number(bandwidthBps);
  if (!Number.isFinite(d) || !Number.isFinite(b) || d <= 0 || b <= 0) return 0;
  return Math.round((d * b) / 8);
}

/**
 * 从响应头里取整个文件的总字节数。
 * 优先看 Content-Range（发过 Range 请求时才有），退回 Content-Length。
 * @param {(name:string)=>string|null} getHeader
 */
export function totalBytesFromHeaders(getHeader) {
  try {
    const cr = getHeader('content-range');
    if (cr) {
      const m = /\/\s*(\d+)\s*$/.exec(String(cr));
      if (m) return Number(m[1]) || 0;
    }
    const cl = Number(getHeader('content-length'));
    return Number.isFinite(cl) && cl > 0 ? cl : 0;
  } catch {
    return 0;
  }
}

/** 取扩展名（含点），拿不到就返回空串。 */
export function extOf(url) {
  try {
    const m = /\.([a-zA-Z0-9]{1,5})$/.exec(new URL(url).pathname);
    return m ? '.' + m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 上一级目录名，用来区分同一页面上的多条同名资源。 */
export function parentName(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    const dir = decodeURIComponent(parts[parts.length - 2]);
    return /^[A-Za-z0-9_-]{1,20}$/.test(dir) ? dir : '';
  } catch {
    return '';
  }
}

/** index.m3u8 / image / 1 这类名字没信息量，遇到就拿页面标题替换。 */
export function isGenericName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  return /^(index|master|playlist|media|video|audio|stream|main|out|hls|dash|file|movie|\d+|segment|master_?playlist|image|img|photo|pic|picture|thumb|thumbnail|avatar|banner|cover|logo|icon|untitled|download|original|large|medium|small|\d+x)$/i.test(
    base
  );
}

/**
 * 用页面标题拼一个像样的文件名。
 * 同目录多条同名时补上级目录名，还不够就补序号。
 * @param {string} title 页面标题
 * @param {string} ext 扩展名（含点）
 * @param {string} url 资源地址，用来取上级目录
 * @param {Iterable<string>} taken 已经占用的文件名
 */
export function composeNameFromTitle(title, ext, url, taken = []) {
  const base = sanitizeFilename(String(title || '').replace(/\.[a-z0-9]{2,5}$/i, ''), 'media');
  if (!base) return '';
  const used = new Set(taken);
  let candidate = base + ext;
  if (used.has(candidate)) {
    const dir = parentName(url);
    if (dir && !base.endsWith('-' + dir)) candidate = `${base}-${dir}${ext}`;
    let n = 2;
    while (used.has(candidate) && n < 50) {
      candidate = `${base}${dir ? '-' + dir : ''}-${n}${ext}`;
      n++;
    }
  }
  return candidate;
}

/** 短 URL，便于在手机上阅读。 */
export function shortUrl(url, max = 64) {
  const s = String(url || '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 3) * 0.6);
  const tail = max - 3 - head;
  return s.slice(0, head) + '...' + s.slice(s.length - tail);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带并发上限的按序流水线。
 * tasks 里每个元素是一个返回 Promise 的函数；结果按原始下标顺序交给 onResult。
 * 内存里最多只保留 windowSize 个已完成但还没交给 onResult 的结果。
 */
export async function orderedPool(items, worker, { concurrency = 4, windowSize = 0, onResult } = {}) {
  const n = items.length;
  const win = Math.max(concurrency, windowSize || concurrency);
  const done = new Map();
  let nextToEmit = 0;
  let nextToStart = 0;
  let firstError = null;

  const flush = async () => {
    while (done.has(nextToEmit)) {
      const v = done.get(nextToEmit);
      done.delete(nextToEmit);
      nextToEmit++;
      if (onResult) await onResult(v, nextToEmit - 1);
    }
  };

  const runOne = async (idx) => {
    const v = await worker(items[idx], idx);
    done.set(idx, v);
  };

  const runners = [];
  const totalRunners = Math.min(concurrency, n);
  for (let r = 0; r < totalRunners; r++) {
    runners.push(
      (async () => {
        while (true) {
          if (firstError) return;
          // 等待窗口腾出位置，避免乱序完成的结果堆在内存里
          while (nextToStart - nextToEmit >= win && !firstError) await sleep(15);
          if (firstError) return;
          const idx = nextToStart++;
          if (idx >= n) return;
          try {
            await runOne(idx);
          } catch (e) {
            if (!firstError) firstError = e;
            return;
          }
          await flush();
        }
      })()
    );
  }

  await Promise.all(runners);
  await flush();
  if (firstError) throw firstError;
  return nextToEmit;
}

/** 简单的指数退避重试。 */
export async function retry(fn, { retries = 3, baseDelay = 400, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      if (onRetry) onRetry(e, i + 1);
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

export function concatUint8(chunks, total) {
  let len = total;
  if (len == null) {
    len = 0;
    for (const c of chunks) len += c.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 这些状态码通常意味着「服务端不愿意给你」，而不是地址写错了。 */
export const BLOCKED_HTTP_STATUS = new Set([401, 403, 410, 451]);

export function isBlockedStatus(status) {
  return BLOCKED_HTTP_STATUS.has(Number(status));
}

/**
 * 把 HTTP 状态码翻译成用户能照着做的说明。
 * 防盗链 CDN 常用 410/403，光看状态码看不出该怎么办，这里补上指引。
 */
export function explainHttpStatus(status, context = '') {
  const code = Number(status);
  const where = context ? `（${context}）` : '';
  if (code === 401) return `需要登录后才能取${where}（401）`;
  if (code === 403) return `服务器拒绝了请求${where}（403）：多半是防盗链校验，回播放页刷新一下再立即下载`;
  if (code === 410) return `地址已失效或被防盗链拦下${where}（410）：回播放页刷新一下再立即下载`;
  if (code === 404) return `地址不存在${where}（404）：可能已经过期`;
  if (code === 429) return `请求太频繁被限流${where}（429）：把并发数调小或稍后再试`;
  if (code >= 500) return `服务器出错${where}（${code}）：稍后重试`;
  return `HTTP ${code}${where}`;
}
