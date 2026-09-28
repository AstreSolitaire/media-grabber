// ============================================================================
// 用户脚本外壳：GM 适配层 + 嗅探 + 界面 + 下载编排
//
// 说明：util / detect / aes / hls / ts2mp4 这几个模块的实现，由
//      tools/build-userscript.mjs 从 extension/src/lib/ 原样拼进来，
//      保证与已通过测试的算法完全一致，不维护第二份实现。
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
      ontimeout: () => reject(new Error('网络请求超时：' + url)),
      onabort: () => reject(new Error('请求已取消')),
    });
  });
}

/**
 * 伪装成 fetch 的样子，好让 hls.js 里已经测过的下载逻辑直接复用。
 * 统一按 arraybuffer 取，需要文本时用 TextDecoder 解，避免发两次请求。
 */
async function gmFetch(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  const r = await gmRequest(url, { method: init.method || 'GET', headers });
  const buf = r.response instanceof ArrayBuffer ? new Uint8Array(r.response) : new Uint8Array(0);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.statusText || '',
    url: r.finalUrl || url,
    text: async () => new TextDecoder('utf-8').decode(buf),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/** 保存成文件。优先用 blob + <a download>，安卓上会落到「下载」目录。 */
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

// ---------------------------------------------------------------- 列表状态

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

/** 名字里没有信息量时，用网页标题代替。 */
function isGenericName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  return /^(index|master|playlist|media|video|audio|stream|main|out|hls|dash|file|movie|\d+|segment|master_?playlist)$/i.test(base);
}

function pageTitle() {
  try {
    return document.title || '';
  } catch {
    return '';
  }
}

function nameForItem(url, contentType, contentDisposition) {
  let name = guessFilename({ url, contentType, contentDisposition });
  const title = pageTitle();
  if (title && isGenericName(name)) {
    const ext = name.slice(name.lastIndexOf('.'));
    const base = sanitizeFilename(String(title).replace(/\.[a-z0-9]{2,5}$/i, ''), 'media');
    let candidate = base + ext;
    if ([...items.values()].some((v) => v.filename === candidate && v.url !== url)) {
      try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const dir = parts.length >= 2 ? decodeURIComponent(parts[parts.length - 2]) : '';
        if (/^[A-Za-z0-9_-]{1,20}$/.test(dir)) candidate = `${base}-${dir}${ext}`;
      } catch {
        /* 忽略 */
      }
    }
    name = candidate;
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
    updateBadge();
    return false;
  }

  if (!isMediaKind(classified.kind)) {
    if (!/^(mp3|mp4|m4a|aac|flac|wav|ogg|opus|webm|mkv|mov|avi|flv|m3u8|m3u)$/.test(ext)) return false;
  }

  const id = itemId(url);
  const prev = items.get(id);
  const item = {
    id,
    url,
    kind: classified.kind === 'unknown' ? (prev ? prev.kind : 'other') : classified.kind,
    ext: classified.ext || (prev && prev.ext) || '',
    contentType: raw.contentType || (prev && prev.contentType) || '',
    contentDisposition: raw.contentDisposition || (prev && prev.contentDisposition) || '',
    size: Number(raw.size) || (prev && prev.size) || 0,
    filename: prev ? prev.filename : nameForItem(url, raw.contentType, raw.contentDisposition),
    host: hostOf(url),
    via: raw.via || '',
    title: pageTitle(),
    variants: prev ? prev.variants : undefined,
  };
  items.set(id, item);
  return true;
}

// ---------------------------------------------------------------- 界面

const KIND_LABEL = { audio: '音频', video: '视频', hls: '流', dash: '流', other: '媒体' };
const KIND_CLASS = { audio: 'mg-chip-audio', video: 'mg-chip-video', hls: 'mg-chip-hls', dash: 'mg-chip-hls', other: 'mg-chip-other' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function shortText(s, max) {
  const str = String(s || '');
  if (str.length <= max) return str;
  const head = Math.ceil((max - 1) * 0.62);
  return str.slice(0, head) + '…' + str.slice(str.length - (max - 1 - head));
}

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
    ui = mountPanel(shadow);
  } catch (e) {
    console.warn('[媒体嗅探下载器] 界面挂载失败', e);
  }
}

function mountPanel(root) {
  const wrap = el('div', 'mg-root');
  const fab = el('button', 'mg-fab');
  fab.type = 'button';
  fab.title = '媒体嗅探下载器';
  fab.textContent = '⬇';
  const badge = el('span', 'mg-badge');
  badge.hidden = true;
  fab.appendChild(badge);

  const panel = el('section', 'mg-panel');
  panel.hidden = true;

  const head = el('header', 'mg-head');
  const title = el('div', 'mg-title');
  title.appendChild(el('span', null, '发现的媒体'));
  const count = el('span', 'mg-count', '0');
  title.appendChild(count);
  head.appendChild(title);
  const actions = el('div', 'mg-head-actions');
  const refresh = el('button', 'mg-icon-btn', '刷新');
  refresh.type = 'button';
  const close = el('button', 'mg-icon-btn', '✕');
  close.type = 'button';
  actions.append(refresh, close);
  head.appendChild(actions);
  panel.appendChild(head);

  const notice = el('div', 'mg-notice');
  notice.hidden = true;
  panel.appendChild(notice);

  const jobsBox = el('div', 'mg-jobs');
  panel.appendChild(jobsBox);

  const list = el('div', 'mg-list');
  panel.appendChild(list);

  const empty = el('div', 'mg-empty');
  empty.innerHTML = '还没有发现可下载的音频或视频。<br>让页面把视频播放一下，或点“刷新”再试。';
  panel.appendChild(empty);

  const foot = el('footer', 'mg-foot');
  const remuxLabel = el('label', 'mg-check');
  const remux = el('input');
  remux.type = 'checkbox';
  remuxLabel.append(remux, el('span', null, 'm3u8 转成 MP4'));
  foot.appendChild(remuxLabel);
  const clear = el('button', 'mg-foot-btn', '清空');
  clear.type = 'button';
  foot.appendChild(clear);
  panel.appendChild(foot);

  wrap.append(fab, panel);
  root.appendChild(wrap);

  let open = false;
  let expandedId = null;
  let noticeTimer = 0;

  function setNotice(text, ms) {
    clearTimeout(noticeTimer);
    if (!text) {
      notice.hidden = true;
      return;
    }
    notice.textContent = text;
    notice.hidden = false;
    if (ms) {
      noticeTimer = setTimeout(() => {
        notice.hidden = true;
      }, ms);
    }
  }

  function render() {
    const list0 = [...items.values()].sort((a, b) => (b.size || 0) - (a.size || 0));
    count.textContent = String(list0.length);
    badge.textContent = String(list0.length);
    badge.hidden = list0.length === 0;
    list.textContent = '';
    empty.hidden = list0.length > 0 || jobs.length > 0;

    for (const it of list0) {
      const row = el('div', 'mg-item');
      row.appendChild(el('span', 'mg-chip ' + (KIND_CLASS[it.kind] || KIND_CLASS.other), KIND_LABEL[it.kind] || '媒体'));

      const main = el('div', 'mg-item-main');
      const name = el('div', 'mg-name', it.filename || it.url);
      name.title = it.url;
      const metaBits = [it.host];
      if (it.size > 0) metaBits.push(formatBytes(it.size));
      if (it.title) metaBits.push(shortText(it.title, 36));
      const meta = el('div', 'mg-meta', metaBits.join(' · '));
      meta.title = it.url;
      main.append(name, meta);
      row.appendChild(main);

      const box = el('div', 'mg-item-actions');
      const btn = el('button', 'mg-btn', it.kind === 'hls' ? '清晰度' : '下载');
      btn.type = 'button';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (it.kind === 'hls' && expandedId !== it.id) {
          expandedId = it.id;
          render();
          await probeItem(it);
          return;
        }
        expandedId = null;
        startJob(it, null);
      });
      box.appendChild(btn);
      row.appendChild(box);

      if (expandedId === it.id) {
        const holder = el('div', 'mg-variants');
        const vs = it.variants;
        if (vs === undefined) holder.appendChild(el('div', 'mg-variant-hint', '正在读取清晰度…'));
        else if (!vs.length) holder.appendChild(el('div', 'mg-variant-hint', '这条流没有多档清晰度，可直接下载。'));
        else {
          for (const v of vs) {
            if (v.iframe) continue;
            const b = el('button', 'mg-btn mg-btn-sm', v.label || '清晰度');
            b.type = 'button';
            b.addEventListener('click', (ev) => {
              ev.stopPropagation();
              expandedId = null;
              startJob(it, v.url);
            });
            holder.appendChild(b);
          }
        }
        const best = el('button', 'mg-btn mg-btn-sm' + (vs && vs.length ? ' mg-btn-ghost' : ''), vs && vs.length ? '最高码率' : '下载');
        best.type = 'button';
        best.addEventListener('click', (ev) => {
          ev.stopPropagation();
          expandedId = null;
          startJob(it, 'best');
        });
        holder.appendChild(best);
        row.appendChild(holder);
      }
      list.appendChild(row);
    }
    renderJobs();
  }

  function renderJobs() {
    jobsBox.textContent = '';
    for (const j of jobs) {
      const box = el('div', 'mg-job');
      const top = el('div', 'mg-job-top');
      top.appendChild(el('div', 'mg-job-name', shortText(j.filename || j.url, 40)));
      top.appendChild(el('div', 'mg-job-pct', j.total ? Math.round((j.current / j.total) * 100) + '%' : ''));
      box.appendChild(top);
      const bar = el('div', 'mg-bar');
      const fill = el('i');
      if (j.total) fill.style.width = Math.min(100, Math.round((j.current / j.total) * 100)) + '%';
      else fill.classList.add('mg-bar-indet');
      bar.appendChild(fill);
      box.appendChild(bar);
      box.appendChild(el('div', 'mg-job-state', j.state || ''));
      jobsBox.appendChild(box);
    }
  }

  fab.addEventListener('click', () => {
    open = !open;
    panel.hidden = !open;
    wrap.classList.toggle('mg-open', open);
  });
  close.addEventListener('click', () => {
    open = false;
    panel.hidden = true;
    wrap.classList.remove('mg-open');
  });
  clear.addEventListener('click', () => {
    items.clear();
    segmentCount = 0;
    render();
    setNotice('已清空。', 1500);
  });
  refresh.addEventListener('click', () => {
    scanDom(document);
    render();
    setNotice('已重新扫描页面。若仍为空，请先播放一下视频。', 3000);
  });
  remux.addEventListener('change', () => {
    settings = { ...settings, remux: remux.checked };
    saveSettings(settings);
    setNotice('设置已保存。', 1500);
  });

  remux.checked = !!settings.remux;
  render();

  return {
    render,
    jobUpdate() {
      renderJobs();
    },
    setNotice,
    openIfNew(hadNone) {
      if (hadNone && items.size) {
        open = true;
        panel.hidden = false;
        wrap.classList.add('mg-open');
      }
    },
  };
}

function updateBadge() {
  if (ui) ui.render();
}

// ---------------------------------------------------------------- 下载

function newJob(item, filename) {
  const job = { id: String(Date.now()), url: item.url, filename: filename || item.filename, current: 0, total: 0, state: '准备中…' };
  jobs.unshift(job);
  if (jobs.length > 4) jobs.pop();
  if (ui) ui.jobUpdate();
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  if (ui) ui.jobUpdate();
}

/** 直链：优先交给 GM_download，失败再退回自己抓。 */
async function downloadDirect(item) {
  const job = newJob(item, item.filename);
  updateJob(job, { state: '已交给下载管理器…' });
  try {
    await gmDownload(item.url, item.filename);
    updateJob(job, { state: '完成', current: 1, total: 1 });
    return;
  } catch (e) {
    updateJob(job, { state: '改由脚本自己抓取…' });
  }
  try {
    const r = await gmRequest(item.url, { responseType: 'arraybuffer', timeout: 300000 });
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(r.response || new ArrayBuffer(0));
    if (!buf.length) throw new Error('没有取到数据');
    updateJob(job, { state: `正在保存 ${formatBytes(buf.length)}…`, current: 1, total: 1 });
    saveBlob(new Blob([buf], { type: item.contentType || 'application/octet-stream' }), item.filename);
    updateJob(job, { state: '完成：' + item.filename });
  } catch (e) {
    updateJob(job, { state: '失败：' + (e.message || e) });
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

  function baseName() {
    const raw = item.filename || item.title || 'media';
    return sanitizeFilename(String(raw).replace(/\.[a-z0-9]{2,5}$/i, ''), 'media') || 'media';
  }

  const onData = async (bytes) => {
    if (!decided) {
      decided = true;
      container = probeContainer(bytes);
      needsRemux = settings.remux !== false && container === 'ts';
      updateJob(job, { state: needsRemux ? '抓取中（稍后转成 MP4）…' : '抓取中…' });
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
    updateJob(job, { current: done, total, state: `分片 ${done}/${total} · ${formatBytes(received)}` });
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
        updateJob(job, { current: done, total, state: `分片 ${done}/${total} · ${formatBytes(p.received)}` });
      },
    });
    if (res.isLive) warnings.push('直播流，只抓到当前窗口');
    if (res.hasDiscontinuity) warnings.push('存在时间戳断点');

    let blob;
    let ext;
    if (needsRemux && remuxParts && remuxParts.length) {
      updateJob(job, { state: `转封装成 MP4…（共 ${formatBytes(received)}）`, current: 1, total: 1 });
      const out = await remuxToMp4(concatUint8(remuxParts));
      warnings.push(...out.warnings);
      blob = new Blob([out.data], { type: out.mime });
      ext = out.ext;
    } else {
      ext = container === 'fmp4' ? '.mp4' : container === 'adts' ? '.aac' : container === 'mp3' ? '.mp3' : '.ts';
      blob = new Blob(parts, { type: ext === '.mp4' ? 'video/mp4' : ext === '.aac' ? 'audio/aac' : ext === '.mp3' ? 'audio/mpeg' : 'video/mp2t' });
      if (container === 'ts') warnings.push('已保存为 .ts（未转 MP4）');
    }
    if (!blob.size) throw new Error('没有抓到任何数据');
    const filename = baseName() + ext;
    updateJob(job, { filename, state: `正在保存 ${formatBytes(blob.size)}…` });
    saveBlob(blob, filename);
    updateJob(job, { state: '完成：' + filename + (warnings.length ? '（' + warnings.join('；') + '）' : '') });
    if (ui) ui.setNotice('已开始保存：' + filename, 5000);
  } catch (e) {
    updateJob(job, { state: '失败：' + (e.message || e) });
    if (ui) ui.setNotice('下载失败：' + (e.message || e), 6000);
  }
}

function startJob(item, variantUrl) {
  if (item.kind === 'hls') downloadHlsItem(item, variantUrl);
  else downloadDirect(item);
}

async function probeItem(item) {
  try {
    const info = await probeHls({ url: item.url, fetchImpl: gmFetch, retries: 1 });
    item.variants = info.type === 'master' ? info.variants : [];
  } catch (e) {
    item.variants = [];
    if (ui) ui.setNotice('读取清晰度失败：' + (e.message || e), 4000);
  }
  if (ui) ui.render();
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
  if (pending.has(abs)) return;
  pending.set(abs, { ...payload, url: abs, frameUrl: location.href });
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
    if (ui) {
      ui.render();
      ui.openIfNew(hadNone);
    }
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

function scanDom(root) {
  try {
    const nodes = root.querySelectorAll ? root.querySelectorAll('video, audio, source') : [];
    for (const n of nodes) {
      const src = n.getAttribute && n.getAttribute('src');
      if (src) report({ url: src, via: 'dom' });
    }
    const links = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
    for (const a of links) {
      const href = a.getAttribute('href');
      if (href && /\.(mp3|mp4|m4a|m3u8|webm|flac|wav|ogg|mkv|mov|avi|ts)(\?|$)/i.test(href)) {
        report({ url: href, via: 'dom-link' });
      }
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
