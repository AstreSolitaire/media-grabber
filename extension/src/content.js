// 内容脚本（隔离世界）。做两件事：
//   1. 把主世界嗅探到的地址转发给后台；
//   2. 在最顶层页面里挂一个悬浮按钮和面板，用来挑选和下载。
// 这是普通脚本，不能 import，所以面板逻辑走 window.MGUI（见 ui.js）。

(function () {
  // 扩展刚安装时会用 chrome.scripting 往已打开的标签页补注一次，这里防重复挂载
  if (window.__mgContentInstalled) return;
  window.__mgContentInstalled = true;

  const isTop = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  // ------------------------------------------------------- 与主世界通信

  // 用来分辨消息是不是我们注进去的脚本发的
  let token = '';
  try {
    token = String(Math.random()).slice(2) + Date.now().toString(36);
    document.documentElement.setAttribute('data-mg-token', token);
  } catch {
    /* 忽略 */
  }

  const pending = new Map();
  let flushTimer = 0;

  function flush() {
    flushTimer = 0;
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending.clear();
    send({ type: 'mg:sniff', items: batch, frameUrl: location.href }).catch(() => {});
  }

  function queue(payload) {
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
    pending.set(abs, {
      url: abs,
      via: payload.via || 'unknown',
      size: Number(payload.size) || 0,
      method: payload.method || 'GET',
      frameUrl: location.href,
      token,
    });
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__mg !== '__mg_sniff__') return;
    queue(d);
  });

  // ------------------------------------------------------- 与后台通信

  function send(msg) {
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

  // ------------------------------------------------------- 面板

  let ui = null;
  let hostEl = null;
  let shadow = null;
  let latest = { items: [], jobs: [], settings: {} };
  let styleLoaded = false;

  function ensureMount() {
    if (!isTop || ui) return;
    try {
      hostEl = document.createElement('div');
      hostEl.id = 'mg-host';
      hostEl.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
      // 挂在 documentElement 上，避免被 body 上的样式或 transform 影响
      (document.documentElement || document.body).appendChild(hostEl);
      shadow = hostEl.attachShadow({ mode: 'open' });

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('src/panel.css');
      link.addEventListener('load', () => {
        styleLoaded = true;
      });
      shadow.appendChild(link);

      ui = window.MGUI.mount(shadow, {
        onDownload: (item, variantUrl) => {
          send({ type: 'mg:download', id: item.id, variantUrl: variantUrl || null });
          ui.setNotice('已开始，进度会显示在面板顶部。', 2500);
        },
        onProbe: (item) => {
          send({ type: 'mg:probe', id: item.id, url: item.url });
        },
        onClear: () => send({ type: 'mg:clear' }),
        onRefresh: () => {
          refresh();
          ui.setNotice('已刷新。若列表仍为空，请让页面先播放一下视频。', 3000);
        },
        onToggleRemux: (v) => send({ type: 'mg:settings', patch: { remux: v } }),
        onCancel: (jobId) => send({ type: 'mg:cancel', jobId }),
        onOpen: () => refresh(),
      });
      applyState(latest);
    } catch (e) {
      // 挂载失败也不能影响页面
      console.warn('[媒体嗅探下载器] 面板挂载失败', e);
    }
  }

  function applyState(state) {
    latest = state || latest;
    if (!ui) return;
    ui.setItems(latest.items || []);
    ui.setJobs(latest.jobs || []);
    ui.setRemux(!!(latest.settings && latest.settings.remux));
  }

  async function refresh() {
    const state = await send({ type: 'mg:getState', frameUrl: location.href });
    if (state) applyState(state);
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'mg:state') {
      const hadNone = !(latest.items && latest.items.length);
      const hasNow = (msg.items || []).length > 0;
      if (hasNow && !ui) ensureMount();
      applyState(msg);
      if (hasNow && hadNone && msg.autoOpen && ui) ui.open();
      respond && respond({ ok: true });
    } else if (msg.type === 'mg:variants') {
      if (ui) ui.setProbe(msg.id, msg.info || null, msg.variants);
      respond && respond({ ok: true });
    } else if (msg.type === 'mg:notice') {
      if (ui) ui.setNotice(msg.text, msg.ms || 3000);
      respond && respond({ ok: true });
    }
    return false;
  });

  // 顶层页面把标题告诉后台，用来给文件起个像样的名字
  if (isTop) {
    const reportTitle = () => send({ type: 'mg:pageinfo', title: document.title || '', url: location.href });
    reportTitle();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', reportTitle, { once: true });
    }
    window.addEventListener('load', reportTitle, { once: true });

    // 首次拿到状态：没有媒体就不挂 UI，免得每张网页都多个按钮
    refresh().then(() => {
      if (latest.items && latest.items.length) ensureMount();
      else applyState(latest);
    });

    // 页面内跳转（S P A）时刷新一次
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        pending.clear();
        reportTitle();
        refresh();
      }
    }, 2000);
  } else {
    // 子框架只负责上报，不挂 UI
    refresh();
  }
})();
