// 抓取页面。跑在扩展自己的源上，所以：
//   - fetch 不受目标站 CORS 限制（有 <all_urls> 主机权限）；
//   - 可以创建 blob: URL，交给 chrome.downloads 落盘。
// 这也是为什么 m3u8 的活必须放在这里，而不是内容脚本里。

import { downloadHls } from './lib/hls.js';
import { remuxToMp4, probeContainer } from './lib/ts2mp4.js';
import { concatUint8, guessFilename, sanitizeFilename, formatBytes, filenameFromDisposition } from './lib/util.js';

const running = new Map(); // jobId -> AbortController
const blobUrls = new Map(); // downloadId -> objectURL

// ---------------------------------------------------------------- 界面

const jobsEl = document.getElementById('jobs');
const emptyEl = document.getElementById('empty');
const cards = new Map();

function card(jobId, name) {
  let c = cards.get(jobId);
  if (c) return c;
  const box = document.createElement('div');
  box.className = 'job';
  const top = document.createElement('div');
  top.className = 'job-top';
  const nm = document.createElement('div');
  nm.className = 'job-name';
  nm.textContent = name || '下载任务';
  const pct = document.createElement('div');
  pct.className = 'job-pct';
  top.append(nm, pct);
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.className = 'indet';
  bar.appendChild(fill);
  const state = document.createElement('div');
  state.className = 'job-state';
  state.textContent = '准备中…';
  box.append(top, bar, state);
  jobsEl.appendChild(box);
  emptyEl.hidden = true;
  c = { box, nm, pct, fill, state };
  cards.set(jobId, c);
  return c;
}

function updateCard(jobId, patch) {
  const c = cards.get(jobId) || card(jobId, patch.name);
  if (patch.name) c.nm.textContent = patch.name;
  if (patch.state) c.state.textContent = patch.state;
  if (patch.done) {
    c.box.classList.add(patch.error ? 'error' : 'done');
    c.fill.classList.remove('indet');
    c.fill.style.width = '100%';
    c.pct.textContent = patch.error ? '失败' : '完成';
  } else if (patch.current != null && patch.total) {
    const p = Math.min(100, Math.max(0, Math.round((patch.current / patch.total) * 100)));
    c.fill.style.width = p + '%';
    c.fill.classList.remove('indet');
    c.pct.textContent = p + '%';
  } else if (patch.current != null) {
    c.pct.textContent = formatBytes(patch.current);
    c.fill.classList.add('indet');
  }
}

// ---------------------------------------------------------------- 与后台通信

function toBackground(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function report(job, patch) {
  if (!job || !job.id) return;
  updateCard(job.id, patch);
  toBackground({
    type: 'mg:job-progress',
    jobId: job.id,
    current: patch.current,
    total: patch.total,
    message: patch.state,
    filename: patch.name,
  });
}

function finish(job, ok, extra) {
  running.delete(job.id);
  toBackground({ type: 'mg:job-done', jobId: job.id, ok, ...(extra || {}) });
}

// ---------------------------------------------------------------- 工具

function baseNameOf(job) {
  const raw = job.filename || job.title || '';
  let base = raw ? sanitizeFilename(raw, '') : '';
  if (!base) {
    base = guessFilename({ url: job.variantUrl || job.url, hint: job.title || '' });
  }
  base = String(base).replace(/\.[a-z0-9]{2,5}$/i, '');
  return sanitizeFilename(base, 'media') || 'media';
}

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
};

function extForContainer(container) {
  switch (container) {
    case 'fmp4':
      return '.mp4';
    case 'adts':
      return '.aac';
    case 'mp3':
      return '.mp3';
    case 'ts':
      return '.ts';
    default:
      return '.ts';
  }
}

function mimeForExt(ext) {
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

async function saveBlob(blob, filename, folder, job, skipFolder) {
  const objectUrl = URL.createObjectURL(blob);
  const path = folder && !skipFolder ? `${folder.replace(/[\\/]+$/, '')}/${filename}` : filename;
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url: objectUrl, filename: path, conflictAction: 'uniquify' });
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    if (folder && !skipFolder) {
      // 部分安卓浏览器不接受带子目录的文件名，去掉目录再试
      return saveBlob(blob, filename, folder, job, true);
    }
    throw e;
  }
  blobUrls.set(downloadId, objectUrl);
  // 兜底：万一 onChanged 没来，15 分钟后也要把内存放掉
  setTimeout(() => {
    if (blobUrls.has(downloadId)) {
      URL.revokeObjectURL(blobUrls.get(downloadId));
      blobUrls.delete(downloadId);
    }
  }, 15 * 60 * 1000);
  return downloadId;
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!blobUrls.has(delta.id)) return;
  if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    const url = blobUrls.get(delta.id);
    blobUrls.delete(delta.id);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* 忽略 */
      }
    }, 5000);
  }
});

function sizeLimit(settings) {
  const mb = Number(settings && settings.remuxLimitMB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 400) * 1024 * 1024;
}

// ---------------------------------------------------------------- HLS 任务

async function runHls(job) {
  const controller = new AbortController();
  running.set(job.id, controller);
  const settings = job.settings || {};
  const concurrency = Math.min(Math.max(Number(settings.concurrency) || 4, 1), 8);
  const referrer = settings.useReferer === false ? '' : job.pageUrl || '';
  const name = baseNameOf(job);

  report(job, { name, state: '正在读取播放列表…' });

  const rawParts = []; // 不转封装时直接攒 Blob，省一份内存
  let remuxParts = null;
  let container = 'unknown';
  let decided = false;
  let needsRemux = false;
  let received = 0;
  let segDone = 0;
  let segTotal = 0;
  const warnings = [];
  let lastReport = 0;

  const onData = async (bytes, meta) => {
    if (!decided) {
      decided = true;
      container = probeContainer(bytes);
      needsRemux = settings.remux !== false && container === 'ts';
      report(job, {
        name,
        state: needsRemux ? '正在抓取分片（稍后转成 MP4）…' : '正在抓取分片…',
      });
    }
    received += bytes.length;
    if (needsRemux) {
      if (!remuxParts) remuxParts = [];
      remuxParts.push(bytes);
      if (received > sizeLimit(settings)) {
        warnings.push(`文件超过 ${Math.round(sizeLimit(settings) / 1048576)}MB，已改为保存原始 .ts（避免手机内存不足）`);
        // 把已经攒下的数据转成 Blob，后面的直接追加
        rawParts.push(new Blob(remuxParts, { type: 'video/mp2t' }));
        remuxParts = null;
        needsRemux = false;
        container = 'ts';
      }
    } else {
      rawParts.push(new Blob([bytes]));
    }
    const now = Date.now();
    if (now - lastReport > 250) {
      lastReport = now;
      report(job, {
        name,
        current: segDone,
        total: segTotal,
        state: `${segTotal ? `分片 ${segDone}/${segTotal}` : '抓取中'} · ${formatBytes(received)}`,
      });
    }
  };

  const res = await downloadHls({
    url: job.variantUrl || job.url,
    fetchImpl: fetch,
    referrer,
    credentials: 'include',
    concurrency,
    retries: 3,
    signal: controller.signal,
    onData,
    onProgress: async (p) => {
      segDone = p.done;
      segTotal = p.total;
      report(job, {
        name,
        current: segDone,
        total: segTotal,
        state: `分片 ${segDone}/${segTotal} · ${formatBytes(p.received)}`,
      });
    },
  });

  if (res.isLive) warnings.push('这是一条直播流，只抓到了当前窗口内的内容');
  if (res.hasDiscontinuity) warnings.push('该流存在时间戳断点，画面可能有跳变');

  let blob;
  let ext;
  if (needsRemux && remuxParts && remuxParts.length) {
    report(job, { name, current: 1, total: 1, state: `转封装成 MP4…（共 ${formatBytes(received)}，大文件会慢一些）` });
    const all = concatUint8(remuxParts);
    remuxParts = null;
    const out = await remuxToMp4(all);
    warnings.push(...out.warnings);
    blob = new Blob([out.data], { type: out.mime });
    ext = out.ext;
    if (out.width && out.height) {
      report(job, { name, current: 1, total: 1, state: `转封装完成：${out.width}×${out.height}，正在保存…` });
    }
  } else {
    ext = extForContainer(container);
    blob = new Blob(rawParts, { type: mimeForExt(ext) });
    if (container === 'ts') warnings.push('内容为 MPEG-TS 切片，已直接拼接为 .ts（未转成 MP4）');
  }

  if (!blob.size) throw new Error('没有抓到任何数据');

  const filename = name + ext;
  report(job, { name: filename, state: `正在保存 ${formatBytes(blob.size)}…` });
  await saveBlob(blob, filename, settings.folder, job);

  finish(job, true, { filename, bytes: blob.size, warnings });
  updateCard(job.id, { name: filename, done: true, state: `已保存：${filename}${warnings.length ? '（' + warnings.join('；') + '）' : ''}` });
}

// ---------------------------------------------------------------- 普通文件（带 Referer 重试）

async function runFile(job) {
  const controller = new AbortController();
  running.set(job.id, controller);
  const settings = job.settings || {};
  const referrer = settings.useReferer === false ? '' : job.pageUrl || '';
  let name = baseNameOf(job);

  report(job, { name, state: '正在连接…' });

  const init = { method: 'GET', credentials: 'include', signal: controller.signal };
  if (referrer) {
    init.referrer = referrer;
    init.referrerPolicy = 'unsafe-url';
  }
  const res = await fetch(job.url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());

  const total = Number(res.headers.get('content-length')) || job.total || 0;
  const contentType = res.headers.get('content-type') || '';
  const disposition = res.headers.get('content-disposition') || '';

  const parts = [];
  const rawChunks = [];
  let received = 0;
  let last = 0;
  const reader = res.body ? res.body.getReader() : null;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(new Blob([value]));
      rawChunks.push(value);
      received += value.length;
      if (Date.now() - last > 300) {
        last = Date.now();
        report(job, { name, current: received, total, state: `已下载 ${formatBytes(received)}${total ? ' / ' + formatBytes(total) : ''}` });
      }
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    parts.push(new Blob([buf]));
    rawChunks.push(buf);
    received = buf.length;
  }

  const warnings = [];
  let blob;
  let ext;
  const first = parts.length ? new Uint8Array(await parts[0].slice(0, 4096).arrayBuffer()) : new Uint8Array(0);
  const container = first.length ? probeContainer(first) : 'unknown';
  if (settings.remux !== false && container === 'ts' && received <= sizeLimit(settings)) {
    report(job, { name, current: 1, total: 1, state: '转封装成 MP4…' });
    const out = await remuxToMp4(concatUint8(rawChunks));
    warnings.push(...out.warnings);
    blob = new Blob([out.data], { type: out.mime });
    ext = out.ext;
  } else {
    const fromCd = filenameFromDisposition(disposition);
    if (fromCd) name = sanitizeFilename(fromCd.replace(/\.[a-z0-9]{2,5}$/i, '') || name, name);
    ext = container === 'fmp4' ? '.mp4' : container === 'adts' ? '.aac' : container === 'mp3' ? '.mp3' : container === 'ts' ? '.ts' : '';
    if (!ext) {
      let path = '';
      try {
        path = new URL(job.url).pathname;
      } catch {
        path = job.url;
      }
      const m = /\.([a-z0-9]{2,5})$/i.exec(path);
      ext = m ? '.' + m[1].toLowerCase() : '';
    }
    blob = new Blob(parts, { type: contentType || mimeForExt(ext) });
  }

  const filename = name + ext;
  report(job, { name: filename, state: `正在保存 ${formatBytes(blob.size)}…` });
  await saveBlob(blob, filename, settings.folder, job);
  finish(job, true, { filename, bytes: blob.size, warnings });
  updateCard(job.id, { name: filename, done: true, state: `已保存：${filename}` });
}

// ---------------------------------------------------------------- 消息

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'mg:ping') {
    respond({ ok: true });
    return false;
  }
  if (msg.type === 'mg:start-hls') {
    const job = msg.job;
    respond({ ok: true });
    runHls(job).catch((e) => {
      const text = String((e && e.message) || e);
      finish(job, false, { error: text });
      updateCard(job.id, { name: job.filename || job.url, done: true, error: true, state: '失败：' + text });
    });
    return false;
  }
  if (msg.type === 'mg:start-file') {
    const job = msg.job;
    respond({ ok: true });
    runFile(job).catch((e) => {
      const text = String((e && e.message) || e);
      finish(job, false, { error: text });
      updateCard(job.id, { name: job.filename || job.url, done: true, error: true, state: '失败：' + text });
    });
    return false;
  }
  if (msg.type === 'mg:cancel') {
    const c = running.get(msg.jobId);
    if (c) c.abort();
    respond({ ok: true });
    return false;
  }
});

toBackground({ type: 'mg:saver-ready' });
