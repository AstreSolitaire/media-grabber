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
