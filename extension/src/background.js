// 后台 service worker：负责嗅探响应头、维护每个标签页的媒体列表、
// 路由界面消息，并把下载任务派给下载管理器或 saver 页面。

import { classify, isMediaKind, isImageKind, isImageContentType, worthSniffing, TINY_IMAGE_BYTES } from './lib/detect.js';
import { guessFilename, sanitizeFilename, extOf, isGenericName, composeNameFromTitle } from './lib/util.js';
import { probeHls } from './lib/hls.js';

const SAVER_PAGE = 'src/saver.html';
const DEFAULT_SETTINGS = {
  remux: true,
  folder: 'MediaGrabber',
  concurrency: 4,
  showFab: true,
  useReferer: true,
  autoCloseSaver: true,
};

// ------------------------------------------------------------------ 状态

/** tabId -> Map(itemId -> item) */
const itemsByTab = new Map();
/** tabId -> Map(dirKey -> {count, sampleUrl})  用于识别 HLS/DASH 分片 */
const segDirsByTab = new Map();
const jobs = new Map();
const titleByTab = new Map();
let saverTabId = null;
let hydrated = false;

function itemId(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function dirKeyOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/[^/]*$/, '');
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 用页面标题给条目起个好名字。
 * 时序上标题（document_start）通常早于媒体请求，但也可能反过来，所以两条路都要能改名。
 * 取名与去重的规则放在 lib/util.js 里，用户脚本用的是同一份实现。
 */
function renameWithTitle(tabId, item, map) {
  const title = titleByTab.get(tabId);
  if (!title) return item;
  const ext = item.ext || extOf(item.url);
  const taken = [...map.values()].filter((v) => v.id !== item.id).map((v) => v.filename);
  const candidate = composeNameFromTitle(title, ext, item.url, taken);
  if (candidate) item.filename = candidate;
  item.title = title;
  return item;
}

// ------------------------------------------------------------------ 设置

let settingsCache = null;

async function getSettings() {
  if (settingsCache) return settingsCache;
  try {
    const got = await chrome.storage.local.get('settings');
    settingsCache = { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache;
}

async function patchSettings(patch) {
  const cur = await getSettings();
  settingsCache = { ...cur, ...patch };
  try {
    await chrome.storage.local.set({ settings: settingsCache });
  } catch {
    /* 忽略 */
  }
  return settingsCache;
}

// ------------------------------------------------------------------ 持久化

function sessionArea() {
  return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
}

let persistTimer = 0;

function schedulePersist() {
  if (!sessionArea()) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const dump = {};
    for (const [tabId, map] of itemsByTab) {
      const list = [...map.values()];
      if (!list.length) continue;
      dump[tabId] = list.slice(-200);
    }
    const segs = {};
    for (const [tabId, map] of segDirsByTab) {
      segs[tabId] = [...map.entries()].map(([k, v]) => [k, v.count, v.sampleUrl]);
    }
    try {
      sessionArea().set({ mgTabs: dump, mgSegs: segs });
    } catch {
      /* 忽略 */
    }
  }, 600);
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const area = sessionArea();
  if (!area) return;
  try {
    const got = await area.get(['mgTabs', 'mgSegs']);
    for (const [tabId, list] of Object.entries(got.mgTabs || {})) {
      const map = new Map();
      for (const it of list) map.set(it.id, it);
      itemsByTab.set(Number(tabId), map);
    }
    for (const [tabId, list] of Object.entries(got.mgSegs || {})) {
      const map = new Map();
      for (const [k, count, sampleUrl] of list) map.set(k, { count, sampleUrl });
      segDirsByTab.set(Number(tabId), map);
    }
  } catch {
    /* 忽略 */
  }
}

// ------------------------------------------------------------------ 列表维护

/** 明确属于切片、不该单独列出来的扩展名 */
const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'cmft', 'dash', 'vtt', 'key']);

function tabItems(tabId) {
  let map = itemsByTab.get(tabId);
  if (!map) {
    map = new Map();
    itemsByTab.set(tabId, map);
  }
  return map;
}

function visibleCount(tabId) {
  const map = itemsByTab.get(tabId);
  if (!map) return 0;
  let n = 0;
  for (const it of map.values()) if (!it.suspect) n++;
  return n;
}

function addItem(tabId, raw) {
  const url = raw.url;
  if (!url) return false;

  const ext = (() => {
    try {
      const p = new URL(url).pathname;
      const m = /\.([a-zA-Z0-9]{1,5})$/.exec(p);
      return m ? m[1].toLowerCase() : '';
    } catch {
      return '';
    }
  })();

  const classified = classify({ url, contentType: raw.contentType || '', contentDisposition: raw.contentDisposition || '' });

  // 分片：不单独入列，只在目录级别记个数，给用户一个「这里有个流」的提示
  if (SEGMENT_EXT.has(ext) && classified.kind !== 'hls') {
    const key = dirKeyOf(url);
    let dirs = segDirsByTab.get(tabId);
    if (!dirs) {
      dirs = new Map();
      segDirsByTab.set(tabId, dirs);
    }
    const cur = dirs.get(key) || { count: 0, sampleUrl: url };
    cur.count++;
    dirs.set(key, cur);
    const map = tabItems(tabId);
    const id = 'seg:' + itemId(key);
    const prev = map.get(id);
    map.set(id, {
      id,
      url: cur.sampleUrl,
      kind: 'other',
      ext,
      suspect: true,
      segmentCount: cur.count,
      filename: `同目录下的分片 ×${cur.count}`,
      host: hostOf(key),
      size: 0,
      title: prev ? prev.title : '',
      pageUrl: raw.pageUrl || '',
      foundAt: prev ? prev.foundAt : Date.now(),
      note: '这些是流的切片，请在上面的列表里选 m3u8',
    });
    schedulePersist();
    return true;
  }

  const KNOWN_EXT = /^(mp3|mp4|m4a|aac|flac|wav|ogg|opus|webm|mkv|mov|avi|flv|m3u8|m3u|mpd|jpg|jpeg|jfif|png|gif|webp|avif|bmp|svg|ico|heic|heif|tif|tiff)$/;
  if (!isMediaKind(classified.kind) && !isImageKind(classified.kind)) {
    // 类型不明但扩展名明显是媒体或图片的，仍然留下
    if (!KNOWN_EXT.test(ext)) return false;
  }

  const id = itemId(url);
  const map = tabItems(tabId);
  const prev = map.get(id);
  const filename =
    prev && prev.contentDisposition === raw.contentDisposition
      ? prev.filename
      : guessFilename({
          url,
          contentType: raw.contentType || (prev && prev.contentType) || '',
          contentDisposition: raw.contentDisposition || (prev && prev.contentDisposition) || '',
          hint: '',
        });

  // 体积取谁：响应头里的 Content-Length/Content-Range 是权威值；
  // 资源时间线给的可能只是视频元素取的那一小段，不能拿来覆盖。
  const incomingSize = Number(raw.size) || 0;
  const fromHeaders = raw.via === 'webRequest';
  let size = incomingSize || (prev && prev.size) || 0;
  if (prev && prev.size > 0 && prev.via === 'webRequest' && !fromHeaders) size = prev.size;

  const item = {
    id,
    url,
    kind: classified.kind === 'unknown' ? (prev ? prev.kind : 'other') : classified.kind,
    ext: classified.ext || (prev && prev.ext) || '',
    contentType: raw.contentType || (prev && prev.contentType) || '',
    contentDisposition: raw.contentDisposition || (prev && prev.contentDisposition) || '',
    size,
    via: fromHeaders ? 'webRequest' : raw.via || (prev && prev.via) || '',
    filename: filename || (prev && prev.filename) || '',
    host: hostOf(url),
    pageUrl: raw.pageUrl || (prev && prev.pageUrl) || '',
    title: titleByTab.get(tabId) || (prev && prev.title) || '',
    suspect: false,
    foundAt: prev ? prev.foundAt : Date.now(),
  };
  if (isGenericName(item.filename)) renameWithTitle(tabId, item, map);
  // 几百字节的图片基本是图标、分隔线或埋点像素，默认折叠到「小图标」里
  if (item.kind === 'image' && item.size > 0 && item.size < TINY_IMAGE_BYTES) item.suspect = true;
  map.set(id, item);
  schedulePersist();
  return true;
}

function listFor(tabId) {
  const map = itemsByTab.get(tabId);
  if (!map) return [];
  return [...map.values()].sort((a, b) => {
    if (a.suspect !== b.suspect) return a.suspect ? 1 : -1;
    return b.foundAt - a.foundAt;
  });
}

function jobsFor(tabId) {
  const now = Date.now();
  return [...jobs.values()]
    .filter((j) => j.tabId === tabId && now - j.startedAt < 6 * 3600 * 1000)
    .map((j) => ({
      id: j.id,
      filename: j.filename || j.url,
      current: j.current,
      total: j.total,
      message: j.message,
      cancelable: !!j.cancelable,
    }));
}

// ------------------------------------------------------------------ 通知界面

const pushTimers = new Map();

function pushState(tabId, extra) {
  if (tabId == null || tabId < 0) return;
  const existing = pushTimers.get(tabId);
  if (existing) return; // 已经排队，合并一次即可
  pushTimers.set(
    tabId,
    setTimeout(async () => {
      pushTimers.delete(tabId);
      const settings = await getSettings();
      const payload = {
        type: 'mg:state',
        items: listFor(tabId),
        jobs: jobsFor(tabId),
        settings,
        ...(extra || {}),
      };
      try {
        await chrome.tabs.sendMessage(tabId, payload);
      } catch {
        /* 页面可能已经关了 */
      }
    }, 200)
  );
}

async function notify(tabId, msg) {
  if (tabId == null || tabId < 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    /* 忽略 */
  }
}

// ------------------------------------------------------------------ 嗅探

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!/^https?:/i.test(details.url)) return;
    if (!worthSniffing(details.url, { requestType: details.type })) return;

    let contentType = '';
    let disposition = '';
    let contentLength = 0;
    let rangeTotal = 0;
    for (const h of details.responseHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = h.value || '';
      else if (name === 'content-disposition') disposition = h.value || '';
      else if (name === 'content-length') contentLength = Number(h.value) || 0;
      else if (name === 'content-range') {
        // 带 Range 的请求（视频元素很常见）只返回一段，Content-Length 是那一段的长度，
        // Content-Range 里的总长度才是文件真实大小。
        const m = /\/\s*(\d+)\s*$/.exec(h.value || '');
        if (m) rangeTotal = Number(m[1]) || 0;
      }
    }
    const size = rangeTotal || contentLength;
    // 只有少数内容类型才需要看，避免把接口请求全记下来
    const ct = contentType.toLowerCase().split(';')[0].trim();
    const interesting =
      ct.startsWith('audio/') ||
      ct.startsWith('video/') ||
      isImageContentType(ct) ||
      ct === 'application/vnd.apple.mpegurl' ||
      ct === 'application/x-mpegurl' ||
      ct === 'audio/mpegurl' ||
      ct === 'audio/x-mpegurl' ||
      ct === 'application/dash+xml' ||
      ct === 'application/octet-stream';
    const extHint = /\.(mp3|mp4|m4a|aac|flac|wav|ogg|opus|webm|mkv|mov|avi|flv|m3u8|m3u|mpd)$/i.test(
      (() => {
        try {
          return new URL(details.url).pathname;
        } catch {
          return '';
        }
      })()
    );
    if (!interesting && !extHint) return;

    const changed = addItem(details.tabId, {
      url: details.url,
      contentType,
      contentDisposition: disposition,
      size,
      via: 'webRequest',
      pageUrl: details.initiator || '',
    });
    if (changed) pushState(details.tabId);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// 标签页导航时清空旧列表
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    itemsByTab.delete(tabId);
    segDirsByTab.delete(tabId);
    schedulePersist();
    pushState(tabId);
  }
  if (changeInfo.title) titleByTab.set(tabId, changeInfo.title);
  if (changeInfo.url && tab && tab.title) titleByTab.set(tabId, tab.title);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  itemsByTab.delete(tabId);
  segDirsByTab.delete(tabId);
  titleByTab.delete(tabId);
  for (const [id, j] of jobs) if (j.tabId === tabId) jobs.delete(id);
  schedulePersist();
  if (saverTabId === tabId) saverTabId = null;
});

// 装好扩展后，把嗅探脚本补进已经打开的标签页
async function injectIntoExistingTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/inject.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/ui.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/content.js'] });
    } catch {
      /* 有些页面装不进去，忽略 */
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoExistingTabs();
});
chrome.runtime.onStartup.addListener(() => {
  hydrate();
});

// ------------------------------------------------------------------ saver 页面

async function pingSaver(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'mg:ping' }, (res) => {
        clearTimeout(timer);
        void chrome.runtime.lastError;
        resolve(!!(res && res.ok));
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function ensureSaver() {
  if (saverTabId != null) {
    try {
      const tab = await chrome.tabs.get(saverTabId);
      if (tab && (await pingSaver(saverTabId))) return saverTabId;
    } catch {
      /* 已关闭 */
    }
    saverTabId = null;
  }
  const url = chrome.runtime.getURL(SAVER_PAGE);
  let tab = null;
  try {
    // 优先放到后台标签页，别打断用户当前在看的页面
    tab = await chrome.tabs.create({ url, active: false });
  } catch {
    try {
      // 个别移动端内核不支持后台新建标签页，退回普通方式
      tab = await chrome.tabs.create({ url });
    } catch (e) {
      return null;
    }
  }
  saverTabId = tab.id;
  // 等页面把消息监听装好
  for (let i = 0; i < 25; i++) {
    if (await pingSaver(saverTabId)) return saverTabId;
    await new Promise((r) => setTimeout(r, 200));
  }
  return saverTabId;
}

let closeSaverTimer = 0;

function scheduleSaverClose() {
  clearTimeout(closeSaverTimer);
  closeSaverTimer = setTimeout(async () => {
    const alive = [...jobs.values()].some((j) => j.viaSaver && !j.finished);
    if (alive) return scheduleSaverClose();
    const settings = await getSettings();
    if (!settings.autoCloseSaver) return;
    if (saverTabId == null) return;
    try {
      await chrome.tabs.remove(saverTabId);
    } catch {
      /* 忽略 */
    }
    saverTabId = null;
  }, 45000);
}

// ------------------------------------------------------------------ 下载

let jobSeq = 0;

function joinName(folder, filename) {
  const name = sanitizeFilename(filename || 'media', 'media');
  if (!folder) return name;
  const f = String(folder).replace(/[\\/]+$/, '').replace(/^[\\/]+/, '');
  if (!f) return name;
  return f + '/' + name;
}

async function startDownload(tabId, itemIdOrItem, variantUrl) {
  await hydrate();
  const map = itemsByTab.get(tabId);
  const item = typeof itemIdOrItem === 'string' ? map && map.get(itemIdOrItem) : itemIdOrItem;
  if (!item) {
    await notify(tabId, { type: 'mg:notice', text: '这条媒体已经不在列表里了，请刷新后重试。' });
    return { ok: false, error: 'not-found' };
  }
  const settings = await getSettings();
  const jobId = 'j' + (++jobSeq) + Date.now().toString(36);
  const job = {
    id: jobId,
    tabId,
    url: item.url,
    variantUrl: variantUrl && variantUrl !== 'best' ? variantUrl : '',
    filename: item.filename || '',
    title: item.title || '',
    pageUrl: item.pageUrl || '',
    kind: item.kind,
    current: 0,
    total: 0,
    message: '准备中…',
    cancelable: true,
    startedAt: Date.now(),
    viaSaver: false,
    finished: false,
  };
  jobs.set(jobId, job);
  pushState(tabId);

  if (item.kind === 'hls' || item.kind === 'dash') {
    if (item.kind === 'dash') {
      job.message = '暂不支持 DASH(.mpd)，请改用 m3u8 地址。';
      job.cancelable = false;
      job.finished = true;
      pushState(tabId);
      return { ok: false, error: 'dash-unsupported' };
    }
    job.message = '正在启动抓取…';
    job.viaSaver = true;
    pushState(tabId);
    const saver = await ensureSaver();
    if (saver == null) {
      job.message = '无法打开抓取页面。';
      job.finished = true;
      job.cancelable = false;
      pushState(tabId);
      return { ok: false, error: 'no-saver' };
    }
    try {
      await chrome.tabs.sendMessage(saver, {
        type: 'mg:start-hls',
        job: { ...job, settings },
      });
    } catch (e) {
      job.message = '与抓取页面通信失败：' + (e.message || e);
      job.finished = true;
      pushState(tabId);
      return { ok: false, error: 'saver-comm' };
    }
    scheduleSaverClose();
    return { ok: true, jobId };
  }

  // 普通文件：先走浏览器下载管理器，流式落盘不吃内存
  const nameOnly = sanitizeFilename(item.filename || guessFilename({ url: item.url, contentType: item.contentType }), 'media');
  job.filename = nameOnly;
  job.message = '已交给浏览器下载…';
  let dlId = null;
  try {
    dlId = await chrome.downloads.download({
      url: item.url,
      filename: joinName(settings.folder, nameOnly),
      conflictAction: 'uniquify',
    });
  } catch (e) {
    // 常见于文件名带子目录被拒（部分安卓浏览器），去掉目录再试一次
    try {
      dlId = await chrome.downloads.download({ url: item.url, filename: nameOnly, conflictAction: 'uniquify' });
    } catch (e2) {
      dlId = null;
    }
  }

  if (dlId != null) {
    job.downloadId = dlId;
    job.total = item.size || 0;
    job.message = '浏览器下载中…';
    job.cancelable = true;
    pushState(tabId);
    return { ok: true, jobId };
  }

  // 下载管理器没能接手，交给 saver 带着页面 Referer 直接抓
  return retryViaSaver(tabId, job, item, settings);
}

/**
 * 用 saver 页面重试。
 * 注意 chrome.downloads 对 HTTP 403 这类失败不会抛异常，而是异步把任务标记为 interrupted，
 * 所以这条路径既服务于「同步失败」，也服务于 onChanged 里报回来的中断。
 */
async function retryViaSaver(tabId, job, item, settings) {
  if (job.saverTried) {
    job.message = '下载失败：直接下载与带 Referer 重试都没成功。';
    job.finished = true;
    job.cancelable = false;
    pushState(tabId);
    return { ok: false, error: 'download-failed' };
  }
  job.saverTried = true;
  job.message = '直接下载失败，改用带 Referer 的方式重试…';
  job.viaSaver = true;
  job.cancelable = true;
  pushState(tabId);
  const saver = await ensureSaver();
  if (saver == null) {
    job.message = '下载失败：无法打开抓取页面。';
    job.finished = true;
    job.cancelable = false;
    pushState(tabId);
    return { ok: false, error: 'no-saver' };
  }
  const filename = joinName(settings.folder, job.filename || item.filename || 'media');
  try {
    await chrome.tabs.sendMessage(saver, {
      type: 'mg:start-file',
      job: { ...job, filename, settings },
    });
  } catch (e) {
    job.message = '下载失败：' + (e.message || e);
    job.finished = true;
    job.cancelable = false;
    pushState(tabId);
    return { ok: false, error: 'saver-comm' };
  }
  scheduleSaverClose();
  return { ok: true, jobId };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const job = [...jobs.values()].find((j) => j.downloadId === delta.id);
  if (!job) return;
  if (delta.bytesReceived) {
    job.current = delta.bytesReceived.current;
    if (delta.totalBytes) job.total = delta.totalBytes.current;
  }
  if (delta.state) {
    const state = delta.state.current;
    if (state === 'complete') {
      job.finished = true;
      job.cancelable = false;
      job.message = '下载完成';
      try {
        const [d] = await chrome.downloads.search({ id: delta.id });
        if (d && d.filename) job.filename = d.filename.replace(/\\/g, '/').split('/').pop();
      } catch {
        /* 忽略 */
      }
      pushState(job.tabId);
      return;
    }
    if (state === 'interrupted') {
      const err = (delta.error && delta.error.current) || '';
      // 防盗链或需要登录时下载管理器不会抛错，只会异步中断，这里换成带 Referer 的方式重试一次
      const retriable = /SERVER_FORBIDDEN|SERVER_UNAUTHORIZED|SERVER_BAD_CONTENT|NETWORK_FAILED|NETWORK_TIMEOUT|CRASH/.test(err);
      if (retriable && !job.saverTried && job.url) {
        job.downloadId = null;
        const settings = await getSettings();
        await retryViaSaver(job.tabId, job, { filename: job.filename }, settings);
        return;
      }
      job.finished = true;
      job.cancelable = false;
      job.message = '下载中断：' + (err || '未知原因');
      pushState(job.tabId);
      return;
    }
  }
  pushState(job.tabId);
});

// ------------------------------------------------------------------ 消息路由

/** 内容脚本能直接从 sender 拿到 tab；扩展弹窗里 sender.tab 是空的，所以允许显式传 tabId。 */
function tabIdOf(msg, sender) {
  if (msg && msg.tabId != null) return msg.tabId;
  return sender && sender.tab ? sender.tab.id : null;
}

async function referrerFor(tabId, sender) {
  if (sender && sender.tab && sender.tab.url) return sender.tab.url;
  if (tabId == null) return '';
  try {
    const tab = await chrome.tabs.get(tabId);
    return (tab && tab.url) || '';
  } catch {
    return '';
  }
}

const HANDLERS = {
  async 'mg:sniff'(msg, sender) {
    await hydrate();
    const tabId = tabIdOf(msg, sender);
    if (tabId == null) return { ok: false };
    const items = Array.isArray(msg.items) ? msg.items : [];
    let changed = false;
    for (const raw of items) {
      const pageUrl = (sender.tab && sender.tab.url) || raw.frameUrl || '';
      if (addItem(tabId, { ...raw, pageUrl })) changed = true;
    }
    if (changed) pushState(tabId, { autoOpen: false });
    return { ok: true };
  },

  async 'mg:getState'(msg, sender) {
    await hydrate();
    const tabId = tabIdOf(msg, sender);
    const settings = await getSettings();
    return { items: listFor(tabId), jobs: jobsFor(tabId), settings };
  },

  async 'mg:pageinfo'(msg, sender) {
    const tabId = tabIdOf(msg, sender);
    if (tabId == null) return { ok: false };
    const title = String(msg.title || '').slice(0, 200);
    titleByTab.set(tabId, title);
    // 标题可能来得比媒体请求晚（也可能早），这里补一次改名
    const map = itemsByTab.get(tabId);
    if (map && title) {
      let changed = false;
      for (const it of map.values()) {
        if (it.suspect) continue;
        const before = it.filename;
        if (isGenericName(it.filename) || (it.title && it.title !== title)) {
          renameWithTitle(tabId, it, map);
          it.title = title;
        } else if (!it.title) {
          it.title = title;
        }
        if (it.filename !== before) changed = true;
      }
      if (changed) pushState(tabId);
    }
    return { ok: true };
  },

  async 'mg:probe'(msg, sender) {
    await hydrate();
    const tabId = tabIdOf(msg, sender);
    const map = tabId != null ? itemsByTab.get(tabId) : null;
    const item = map && map.get(msg.id);
    const url = (item && item.url) || msg.url;
    const referrer = await referrerFor(tabId, sender);
    try {
      const info = await probeHls({ url, fetchImpl: fetch, referrer, retries: 1 });
      if (tabId != null) {
        await notify(tabId, {
          type: 'mg:variants',
          id: msg.id,
          variants: info.type === 'master' ? info.variants : [],
          info,
        });
      }
      return info;
    } catch (e) {
      if (tabId != null) {
        await notify(tabId, { type: 'mg:variants', id: msg.id, variants: null, info: { error: String((e && e.message) || e) } });
      }
      return { error: String((e && e.message) || e) };
    }
  },

  async 'mg:download'(msg, sender) {
    const tabId = tabIdOf(msg, sender);
    if (tabId == null) return { ok: false };
    return startDownload(tabId, msg.id, msg.variantUrl);
  },

  async 'mg:clear'(msg, sender) {
    const tabId = tabIdOf(msg, sender);
    if (tabId == null) return { ok: false };
    itemsByTab.delete(tabId);
    segDirsByTab.delete(tabId);
    schedulePersist();
    pushState(tabId);
    return { ok: true };
  },

  async 'mg:settings'(msg) {
    const next = await patchSettings(msg.patch || {});
    return { ok: true, settings: next };
  },

  async 'mg:cancel'(msg, sender) {
    const tabId = tabIdOf(msg, sender);
    const job = jobs.get(msg.jobId);
    if (!job) return { ok: false };
    if (job.downloadId != null) {
      try {
        await chrome.downloads.cancel(job.downloadId);
      } catch {
        /* 忽略 */
      }
    }
    if (job.viaSaver && saverTabId != null) {
      try {
        await chrome.tabs.sendMessage(saverTabId, { type: 'mg:cancel', jobId: job.id });
      } catch {
        /* 忽略 */
      }
    }
    job.message = '已取消';
    job.finished = true;
    job.cancelable = false;
    pushState(tabId != null ? tabId : job.tabId);
    return { ok: true };
  },

  // ---- 来自 saver 页面的消息 ----

  async 'mg:saver-ready'(msg, sender) {
    if (sender.tab && sender.tab.id != null) saverTabId = sender.tab.id;
    return { ok: true };
  },

  async 'mg:job-progress'(msg, sender) {
    if (sender.tab && sender.tab.id != null) saverTabId = sender.tab.id;
    const job = jobs.get(msg.jobId);
    if (!job) return { ok: false };
    job.current = msg.current || 0;
    job.total = msg.total || 0;
    job.message = msg.message || job.message;
    if (msg.filename) job.filename = msg.filename;
    pushState(job.tabId);
    return { ok: true };
  },

  async 'mg:job-done'(msg, sender) {
    if (sender.tab && sender.tab.id != null) saverTabId = sender.tab.id;
    const job = jobs.get(msg.jobId);
    if (!job) return { ok: false };
    job.finished = true;
    job.cancelable = false;
    if (msg.ok) {
      job.current = job.total = Math.max(job.current, msg.bytes || 0);
      job.filename = msg.filename || job.filename;
      job.message = '已完成' + (msg.warnings && msg.warnings.length ? '（' + msg.warnings.join('；') + '）' : '');
    } else {
      job.message = '失败：' + (msg.error || '未知原因');
    }
    pushState(job.tabId);
    scheduleSaverClose();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (msg.type === 'mg:ping') {
    respond({ ok: true, saver: true });
    return true;
  }
  const handler = HANDLERS[msg.type];
  if (!handler) return;
  Promise.resolve(handler(msg, sender))
    .then((res) => respond(res || { ok: true }))
    .catch((e) => respond({ ok: false, error: String((e && e.message) || e) }));
  return true; // 异步回复
});

getSettings();
