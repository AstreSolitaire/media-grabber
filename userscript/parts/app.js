// ============================================================================
// 用户脚本外壳：GM 适配层 + 嗅探 + 下载编排
//
// 界面（ui.js + panel.css）和算法（lib/*.js）都由 tools/build-userscript.mjs
// 从扩展源码原样内联进来，这里只写用户脚本特有的部分：
//   - GM_xmlhttpRequest / GM_download 适配
//   - 主世界钩子的安装（unsafeWindow）
//   - 列表维护与下载编排（不需要额外的抓取页，GM 请求本身就跨域）
// ============================================================================

const IS_TOP = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------- 设置

const SETTINGS_KEY = 'mg-settings';
const DEFAULT_SETTINGS = { remux: true, concurrency: 4, remuxLimitMB: 400 };

function loadSettings() {
  try {
    const raw = typeof GM_getValue === 'function' ? GM_getValue(SETTINGS_KEY, '') : localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(next) {
  const text = JSON.stringify(next);
  try {
    if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_KEY, text);
    else localStorage.setItem(SETTINGS_KEY, text);
  } catch {
    /* 忽略 */
  }
}

let settings = loadSettings();

// ---------------------------------------------------------------- GM 适配层

/** 用 GM_xmlhttpRequest 取数据。它是用户脚本能跨域抓分片的关键。 */
function gmRequest(url, { method = 'GET', headers = {}, timeout = 120000, responseType = 'arraybuffer' } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      reject(new Error('用户脚本管理器没有提供 GM_xmlhttpRequest'));
      return;
    }
    GM_xmlhttpRequest({
      method,
      url,
      headers,
      timeout,
      responseType,
      anonymous: false, // 带上目标站点的 Cookie
      onload: (r) => resolve(r),
      onerror: () => reject(new Error('网络请求失败：' + url)),
      onloadstart: undefined,
      ontimeout: () => reject(new Error('网络请求超时：' + url)),
      onabort: () => reject(new Error('请求已取消')),
    });
  });
}

/** 解析 GM_xmlhttpRequest 返回的响应头字符串，做成 fetch 那样的 get()。 */
function headersFromRaw(raw) {
  const map = new Map();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { get: (name) => map.get(String(name).toLowerCase()) || null };
}

function wrapGmResponse(r, url) {
  const buf = r.response instanceof ArrayBuffer ? new Uint8Array(r.response) : new Uint8Array(0);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.statusText || '',
    url: r.finalUrl || url,
    headers: headersFromRaw(r.responseHeaders),
    text: async () => new TextDecoder('utf-8').decode(buf),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/**
 * 用「页面自己的身份」发请求：带页面的 Referer、Origin 和 Cookie。
 *
 * 这是绕开防盗链的关键——播放器就是这么取的，请求特征完全一致。
 * 跨域能成是因为播放器本身也要用 XHR 取分片，说明 CDN 对该站点开了 CORS。
 */
async function pageFetch(url, init = {}) {
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const res = await W.fetch(url, {
    method: init.method || 'GET',
    headers: { ...(init.headers || {}) },
    credentials: 'include',
    referrer: location.href,
    referrerPolicy: 'unsafe-url',
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText || '',
    url: res.url || url,
    headers: res.headers,
    text: async () => new TextDecoder('utf-8').decode(buf),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    viaPage: true,
  };
}

/**
 * 伪装成 fetch 的样子，好让 hls.js 里已经测过的下载逻辑直接复用。
 * 先用 GM_xmlhttpRequest（不受 CORS 限制、覆盖广）；
 * 如果被服务端拒绝（401/403/410 这类防盗链常见状态），
 * 再以页面身份重发一次——很多 CDN 只认播放器发出来的那种请求。
 */
async function gmFetch(url, init = {}) {
  const r = await gmRequest(url, { method: init.method || 'GET', headers: { ...(init.headers || {}) } });
  if (isBlockedStatus(r.status)) {
    try {
      const alt = await pageFetch(url, init);
      if (alt.ok) {
        console.log('[媒体嗅探下载器] GM 请求被拒（' + r.status + '），改用页面身份请求成功：' + url);
        return alt;
      }
    } catch (e) {
      console.log('[媒体嗅探下载器] 页面身份请求也没成功：' + (e && e.message));
    }
  }
  return wrapGmResponse(r, url);
}

/** 保存成文件。blob + <a download> 在安卓上会落到「下载」目录。 */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  (document.body || document.documentElement).appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* 忽略 */
    }
  }, 120000);
  return filename;
}

/** 直链优先走 GM_download（能指定文件名，且不用把整个文件读进内存）。 */
function gmDownload(url, name) {
  return new Promise((resolve, reject) => {
    if (typeof GM_download !== 'function') {
      reject(new Error('没有 GM_download'));
      return;
    }
    GM_download({
      url,
      name,
      saveAs: false,
      onload: () => resolve(name),
      onerror: (e) => reject(new Error((e && (e.error || e.details)) || '下载失败')),
      ontimeout: () => reject(new Error('下载超时')),
    });
  });
}

// ---------------------------------------------------------------- 列表

/** url -> item */
const items = new Map();
const jobs = [];

function itemId(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'cmft', 'dash', 'vtt', 'key']);
const KNOWN_EXT = /^(mp3|mp4|m4a|m4b|aac|flac|wav|ogg|oga|opus|weba|webm|mkv|mov|avi|flv|m3u8|m3u|mpd|jpg|jpeg|jfif|png|gif|webp|avif|bmp|svg|ico|heic|heif|tif|tiff)$/;

function pageTitle() {
  try {
    return document.title || '';
  } catch {
    return '';
  }
}

function nameForItem(url, contentType, contentDisposition) {
  let name = guessFilename({ url, contentType, contentDisposition });
  if (pageTitle() && isGenericName(name)) {
    const ext = name.slice(name.lastIndexOf('.'));
    const taken = [...items.values()].map((v) => v.filename);
    const candidate = composeNameFromTitle(pageTitle(), ext, url, taken);
    if (candidate) name = candidate;
  }
  return name;
}

let segmentCount = 0;

function addHit(raw) {
  const url = raw.url;
  if (!url || !/^https?:/i.test(url)) return false;

  const ext = (() => {
    try {
      const m = /\.([a-zA-Z0-9]{1,5})$/.exec(new URL(url).pathname);
      return m ? m[1].toLowerCase() : '';
    } catch {
      return '';
    }
  })();

  const classified = classify({ url, contentType: raw.contentType || '', contentDisposition: raw.contentDisposition || '' });

  // 分片不单独入列，只统计数量，免得列表被几百个 .ts 淹没
  if (SEGMENT_EXT.has(ext) && classified.kind !== 'hls') {
    segmentCount++;
    return false;
  }
  if (!isMediaKind(classified.kind) && !isImageKind(classified.kind)) {
    if (!KNOWN_EXT.test(ext)) return false;
  }

  const id = itemId(url);
  const prev = items.get(id);
  if (prev) {
    // 同一条资源会被多次上报（fetch 钩子、资源时间线、DOM 扫描），
    // 后到的信息往往更全（体积、Content-Type），要合并进去而不是直接丢掉。
    let changed = false;
    const size = Number(raw.size) || 0;
    if (!prev.size && size > 0) {
      prev.size = size;
      changed = true;
    }
    if (!prev.contentType && raw.contentType) {
      prev.contentType = raw.contentType;
      changed = true;
    }
    if ((prev.kind === 'other' || !prev.kind) && classified.kind !== 'unknown' && classified.kind !== 'other') {
      prev.kind = classified.kind;
      changed = true;
    }
    if (changed && prev.kind === 'image' && prev.size > 0 && prev.size < TINY_IMAGE_BYTES) prev.suspect = true;
    return changed;
  }

  const item = {
    id,
    url,
    kind: classified.kind,
    ext: classified.ext || '',
    contentType: raw.contentType || '',
    size: Number(raw.size) || 0,
    filename: nameForItem(url, raw.contentType, raw.contentDisposition),
    host: hostOf(url),
    title: pageTitle(),
    via: raw.via || '',
  };
  // 几百字节的图片基本是图标或埋点像素，默认折叠
  if (item.kind === 'image' && item.size > 0 && item.size < TINY_IMAGE_BYTES) item.suspect = true;
  // 已经知道某个目录下的这类文件是分片，新出现的也直接折叠
  if (!item.suspect && knownSegments.dirs.size && isKnownSegment(item.url)) item.suspect = true;
  items.set(id, item);
  return true;
}

// ---------------------------------------------------------------- 界面

let ui = null;

function ensureUi() {
  if (!IS_TOP || ui) return;
  try {
    const host = document.createElement('div');
    host.id = 'mg-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    (document.documentElement || document.body).appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    ui = window.MGUI.mount(shadow, {
      onDownload: (item, variantUrl) => {
        if (item.kind === 'hls') downloadHlsItem(item, variantUrl);
        else downloadDirect(item);
      },
      onProbe: (item) => probeItem(item),
      onNeedSize: (item) => probeSize(item),
      onClear: () => {
        items.clear();
        segmentCount = 0;
        ui.setItems([...items.values()]);
        ui.setNotice('已清空。', 1500);
      },
      onRefresh: () => {
        scanDom(document);
        ui.setItems([...items.values()]);
        ui.setNotice('已重新扫描页面。若仍为空，请先播放一下视频。', 3000);
      },
      onToggleRemux: (v) => {
        settings = { ...settings, remux: v };
        saveSettings(settings);
        ui.setNotice('设置已保存：m3u8 转 MP4 ' + (v ? '开' : '关'), 2000);
      },
    });
    ui.setRemux(settings.remux);
    ui.setItems([...items.values()]);
  } catch (e) {
    console.warn('[媒体嗅探下载器] 界面挂载失败', e);
  }
}

function syncUi() {
  if (!ui) return;
  ui.setItems([...items.values()]);
  ui.setJobs(jobs);
}

// ---------------------------------------------------------------- 下载

function newJob(item, filename) {
  const job = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    url: item.url,
    filename: filename || item.filename,
    current: 0,
    total: 0,
    message: '准备中…',
    cancelable: false,
  };
  jobs.unshift(job);
  if (jobs.length > 4) jobs.pop();
  syncUi();
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  syncUi();
}

/** 直链：优先交给 GM_download，失败再自己抓。 */
async function downloadDirect(item) {
  const job = newJob(item, item.filename);
  updateJob(job, { message: '已交给下载管理器…' });
  try {
    await gmDownload(item.url, item.filename);
    updateJob(job, { message: '完成', current: 1, total: 1 });
    return;
  } catch (e) {
    updateJob(job, { message: '改由脚本自己抓取…' });
  }
  try {
    const r = await gmRequest(item.url, { responseType: 'arraybuffer', timeout: 300000 });
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(r.response || new ArrayBuffer(0));
    if (!buf.length) throw new Error('没有取到数据');
    updateJob(job, { message: `正在保存 ${formatBytes(buf.length)}…`, current: 1, total: 1 });
    saveBlob(new Blob([buf], { type: item.contentType || 'application/octet-stream' }), item.filename);
    updateJob(job, { message: '完成：' + item.filename });
  } catch (e) {
    updateJob(job, { message: '失败：' + (e.message || e) });
  }
}

/** HLS：抓分片 → 需要时转封装 → 保存。 */
async function downloadHlsItem(item, variantUrl) {
  const job = newJob(item, item.filename);
  const limit = (settings.remuxLimitMB || 400) * 1024 * 1024;
  const parts = [];
  let remuxParts = null;
  let container = 'unknown';
  let needsRemux = false;
  let decided = false;
  let received = 0;
  let done = 0;
  let total = 0;
  const warnings = [];

  const baseName = () =>
    sanitizeFilename(String(item.filename || item.title || 'media').replace(/\.[a-z0-9]{2,5}$/i, ''), 'media') || 'media';

  const onData = async (bytes) => {
    if (!decided) {
      decided = true;
      container = probeContainer(bytes);
      needsRemux = settings.remux !== false && container === 'ts';
      updateJob(job, { message: needsRemux ? '抓取中（稍后转成 MP4）…' : '抓取中…' });
    }
    received += bytes.length;
    if (needsRemux) {
      if (!remuxParts) remuxParts = [];
      remuxParts.push(bytes);
      if (received > limit) {
        warnings.push(`超过 ${settings.remuxLimitMB}MB，改为保存原始 .ts`);
        parts.push(new Blob(remuxParts, { type: 'video/mp2t' }));
        remuxParts = null;
        needsRemux = false;
        container = 'ts';
      }
    } else {
      parts.push(new Blob([bytes]));
    }
    updateJob(job, { current: done, total, message: `分片 ${done}/${total} · ${formatBytes(received)}` });
  };

  try {
    const res = await downloadHls({
      url: variantUrl && variantUrl !== 'best' ? variantUrl : item.url,
      fetchImpl: gmFetch,
      concurrency: Math.min(Math.max(Number(settings.concurrency) || 4, 1), 8),
      retries: 3,
      onData,
      cryptoImpl: (typeof unsafeWindow !== 'undefined' && unsafeWindow.crypto) || crypto,
      onProgress: async (p) => {
        done = p.done;
        total = p.total;
        updateJob(job, { current: done, total, message: `分片 ${done}/${total} · ${formatBytes(p.received)}` });
      },
    });
    if (res.isLive) warnings.push('直播流，只抓到当前窗口');
    if (res.hasDiscontinuity) warnings.push('存在时间戳断点');

    let blob;
    let ext;
    if (needsRemux && remuxParts && remuxParts.length) {
      updateJob(job, { message: `转封装成 MP4…（共 ${formatBytes(received)}）`, current: 1, total: 1 });
      const out = await remuxToMp4(concatUint8(remuxParts));
      warnings.push(...out.warnings);
      blob = new Blob([out.data], { type: out.mime });
      ext = out.ext;
    } else {
      ext = container === 'fmp4' ? '.mp4' : container === 'adts' ? '.aac' : container === 'mp3' ? '.mp3' : '.ts';
      blob = new Blob(parts, {
        type: ext === '.mp4' ? 'video/mp4' : ext === '.aac' ? 'audio/aac' : ext === '.mp3' ? 'audio/mpeg' : 'video/mp2t',
      });
      if (container === 'ts') warnings.push('已保存为 .ts（未转 MP4）');
    }
    if (!blob.size) throw new Error('没有抓到任何数据');
    const filename = baseName() + ext;
    updateJob(job, { filename, message: `正在保存 ${formatBytes(blob.size)}…` });
    saveBlob(blob, filename);
    updateJob(job, { message: '完成：' + filename + (warnings.length ? '（' + warnings.join('；') + '）' : '') });
    if (ui) ui.setNotice('已开始保存：' + filename, 5000);
  } catch (e) {
    updateJob(job, { message: '失败：' + (e.message || e) });
    if (ui) ui.setNotice('下载失败：' + (e.message || e), 6000);
  }
}

/**
 * 把某条流涉及的分片从列表里折叠起来。
 * 两类都算：
 *   1. 播放列表里明确列出的分片地址（精确匹配）
 *   2. 同一目录下名字明显是分片的文件（有些站的 fMP4 分片叫 init-xxx.mp4 / segN-xxx.mp4，
 *      光看扩展名会被当成独立视频列出来，点下载必然失败）
 */
function hideSegmentsOf(info, playlistUrl) {
  const urls = (info && info.segmentUrls) || [];
  for (const u of urls) if (knownSegments.urls.size < 3000) knownSegments.urls.add(u);
  try {
    const u = new URL(playlistUrl);
    knownSegments.dirs.add(u.origin + u.pathname.replace(/[^/]*$/, ''));
  } catch {
    /* 拿不到目录就算了 */
  }
  const changed = foldKnownSegments();
  if (changed && ui) ui.setNotice('已把这条流的 ' + changed + ' 个分片折叠起来（流本身在上面）', 4000);
}

/**
 * 把已知分片折叠起来。
 * 记下来而不是只折一次：长视频会不断产生新分片，探测之后才出现的分片同样不该混进列表。
 */
function foldKnownSegments() {
  let changed = 0;
  for (const it of items.values()) {
    if (it.suspect) continue;
    if (!isKnownSegment(it.url)) continue;
    it.suspect = true;
    changed++;
  }
  return changed;
}

function isKnownSegment(url) {
  if (knownSegments.urls.has(url)) return true;
  for (const dir of knownSegments.dirs) {
    if (url.startsWith(dir) && SEGMENT_NAME_RE.test(url.slice(dir.length))) return true;
  }
  return false;
}

/** 已经确认是分片的地址与目录，之后新出现的同类条目也一并折叠 */
const knownSegments = { urls: new Set(), dirs: new Set() };

const sizeProbed = new Set();

/**
 * 问一下文件的真实大小。
 * 先用 HEAD（不下载任何内容，最安全）；HEAD 被拒时，只对图片补一次 1 字节的
 * Range 请求——音视频可能有几百兆，不能冒服务器无视 Range 的风险。
 */
async function probeSize(item) {
  if (!item || sizeProbed.has(item.id)) return;
  if (item.kind === 'hls' || item.kind === 'dash') return;
  sizeProbed.add(item.id);

  const apply = (total) => {
    if (!(total > 0)) return false;
    // 资源时间线里的 transferSize 可能只是文件开头一段，这里以实际长度为准
    item.size = total;
    if (item.kind === 'image' && total < TINY_IMAGE_BYTES) item.suspect = true;
    syncUi();
    return true;
  };

  try {
    const r = await gmRequest(item.url, { method: 'HEAD', timeout: 15000 });
    if (r.status >= 200 && r.status < 400) {
      const total = totalBytesFromHeaders((n) => headersFromRaw(r.responseHeaders).get(n));
      if (apply(total)) return;
    }
  } catch {
    /* HEAD 不行就走下面 */
  }

  if (item.kind !== 'image') return;
  try {
    const r = await gmRequest(item.url, { headers: { Range: 'bytes=0-0' }, timeout: 15000 });
    apply(totalBytesFromHeaders((n) => headersFromRaw(r.responseHeaders).get(n)));
  } catch {
    /* 问不到就显示未知 */
  }
}

async function probeItem(item) {
  try {
    const info = await probeHls({ url: item.url, fetchImpl: gmFetch, retries: 1 });
    hideSegmentsOf(info, item.url);
    if (ui) ui.setProbe(item.id, info, info.type === 'master' ? info.variants : []);
  } catch (e) {
    console.log('[媒体嗅探下载器] 读取清晰度失败：' + item.url + ' → ' + ((e && e.message) || e));
    if (ui) ui.setProbe(item.id, { error: String((e && e.message) || e) }, null);
    if (ui) ui.setNotice('读取清晰度失败：' + (e.message || e), 4000);
  }
}

// ---------------------------------------------------------------- 嗅探

const pending = new Map();

function report(payload) {
  if (IS_TOP) {
    queueHit(payload);
  } else {
    try {
      window.top.postMessage({ __mg: '__mg_sniff__', ...payload }, '*');
    } catch {
      /* 忽略 */
    }
  }
}

function queueHit(payload) {
  const url = payload && payload.url;
  if (!url || typeof url !== 'string') return;
  let abs = url;
  try {
    abs = new URL(url, location.href).href;
  } catch {
    return;
  }
  if (!/^https?:/i.test(abs)) return;
  const queued = pending.get(abs);
  if (queued) {
    // 同一条资源会被多个钩子上报（fetch 先到、资源时间线后到且带体积），
    // 这里必须合并而不是丢弃，否则体积信息就丢了。
    if (!queued.size && payload.size) queued.size = payload.size;
    if (!queued.contentType && payload.contentType) queued.contentType = payload.contentType;
    return;
  }
  pending.set(abs, { ...payload, url: abs });
  if (pending.size > 400) flushPending();
  if (!queueHit.timer) queueHit.timer = setTimeout(flushPending, 400);
}

function flushPending() {
  clearTimeout(queueHit.timer);
  queueHit.timer = 0;
  if (!pending.size) return;
  const batch = [...pending.values()];
  pending.clear();
  const hadNone = items.size === 0;
  let changed = false;
  for (const raw of batch) {
    if (/\/seg\d+\.(ts|m4s)$/i.test(raw.url)) continue;
    if (addHit(raw)) changed = true;
  }
  if (changed) {
    ensureUi();
    syncUi();
    if (ui && hadNone && items.size) ui.open();
  }
}

function installHooks() {
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  try {
    const origFetch = W.fetch;
    if (typeof origFetch === 'function') {
      W.fetch = function (input, init) {
        try {
          let url = '';
          if (typeof input === 'string') url = input;
          else if (input && typeof input.url === 'string') url = input.url;
          if (url) report({ url, via: 'fetch', method: (init && init.method) || 'GET' });
        } catch {
          /* 忽略 */
        }
        return origFetch.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  try {
    const XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
      const origOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        try {
          if (typeof url === 'string') report({ url, via: 'xhr', method });
        } catch {
          /* 忽略 */
        }
        return origOpen.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  try {
    const PO = W.PerformanceObserver;
    if (typeof PO === 'function') {
      const po = new PO((list) => {
        try {
          for (const e of list.getEntries()) {
            if (e && e.name) report({ url: e.name, via: 'perf', size: e.transferSize || e.encodedBodySize || 0 });
          }
        } catch {
          /* 忽略 */
        }
      });
      po.observe({ type: 'resource', buffered: true });
    }
  } catch {
    /* 忽略 */
  }
}

const IMAGE_NAME_RE = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|svg|ico|heic|heif)(\?|$)/i;
const MEDIA_NAME_RE = /\.(mp3|mp4|m4a|m4v|m3u8|webm|flac|wav|ogg|opus|mkv|mov|avi|ts)(\?|$)/i;
/** 文件名看起来就是分片的样子（同目录下才判定） */
const SEGMENT_NAME_RE = /^(init|seg|chunk|frag|part|slice)[-_]?\d*([-_].*)?\.(mp4|m4s|ts|aac|m4a|mp3|cmfv|cmfa)$/i;

const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-actualsrc', 'data-echo'];

function pickFromSrcset(value) {
  if (!value) return '';
  const parts = String(value).split(',');
  for (let i = parts.length - 1; i >= 0; i--) {
    const url = parts[i].trim().split(/\s+/)[0];
    if (url) return url;
  }
  return '';
}

function scanDom(root) {
  try {
    const nodes = root.querySelectorAll ? root.querySelectorAll('video, audio, source') : [];
    for (const n of nodes) {
      const src = n.getAttribute && n.getAttribute('src');
      if (src) report({ url: src, via: 'dom' });
      const poster = n.getAttribute && n.getAttribute('poster');
      if (poster) report({ url: poster, via: 'dom-poster' });
    }

    let budget = 120;
    const imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    for (const img of imgs) {
      if (budget-- <= 0) break;
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (src) report({ url: src, via: 'dom-img' });
      else {
        let lazy = '';
        for (const attr of LAZY_ATTRS) {
          const v = img.getAttribute && img.getAttribute(attr);
          if (v) {
            lazy = v;
            break;
          }
        }
        if (!lazy) lazy = pickFromSrcset(img.getAttribute && img.getAttribute('srcset'));
        if (lazy && IMAGE_NAME_RE.test(lazy)) report({ url: lazy, via: 'dom-img-lazy' });
      }
    }

    const links = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
    for (const a of links) {
      const href = a.getAttribute('href');
      if (href && (MEDIA_NAME_RE.test(href) || IMAGE_NAME_RE.test(href))) report({ url: href, via: 'dom-link' });
    }
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------- 启动

installHooks();

if (IS_TOP) {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__mg !== '__mg_sniff__') return;
    queueHit(d);
  });
}

try {
  scanDom(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scanDom(document), { once: true });
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    let scheduled = false;
    const mo = new MutationObserver((records) => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        for (const r of records) {
          for (const n of r.addedNodes || []) if (n.nodeType === 1) scanDom(n);
        }
      }, 400);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
} catch {
  /* 忽略 */
}
