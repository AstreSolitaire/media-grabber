// 扩展弹窗（桌面版 Edge 用）。手机上 Edge 没有工具栏弹窗，
// 直接用网页里注入的悬浮面板，走的是同一套后台逻辑。

(function () {
  let tabId = null;
  let ui = null;
  let settings = {};
  let pollTimer = 0;

  const el = window.MGUI.el;

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

  async function activeTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          void chrome.runtime.lastError;
          resolve((tabs && tabs[0]) || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function applySettings(s) {
    settings = s || {};
    const folder = document.getElementById('folder');
    const conc = document.getElementById('concurrency');
    const ref = document.getElementById('referer');
    const ac = document.getElementById('autoclose');
    if (folder) folder.value = settings.folder || '';
    if (conc) conc.value = String(settings.concurrency || 4);
    if (ref) ref.checked = settings.useReferer !== false;
    if (ac) ac.checked = settings.autoCloseSaver !== false;
  }

  async function refresh() {
    if (tabId == null) return;
    const state = await send({ type: 'mg:getState', tabId });
    if (!state) return;
    if (ui) {
      ui.setItems(state.items || []);
      ui.setJobs(state.jobs || []);
      ui.setRemux(!!(state.settings && state.settings.remux));
    }
    applySettings(state.settings);
  }

  async function init() {
    const app = document.getElementById('app');
    if (!window.MGUI) {
      app.appendChild(el('div', 'mg-empty', '面板脚本没有加载成功，请重新打开扩展。'));
      return;
    }
    const tab = await activeTab();
    tabId = tab ? tab.id : null;

    ui = window.MGUI.mount(app, {
      embedded: true,
      onDownload: async (item, variantUrl) => {
        if (tabId == null) return;
        ui.setNotice('已开始。切回页面可以看到进度。', 2500);
        await send({ type: 'mg:download', tabId, id: item.id, variantUrl: variantUrl || null });
        refresh();
      },
      onProbe: async (item) => {
        if (tabId == null) return;
        const info = await send({ type: 'mg:probe', tabId, id: item.id, url: item.url });
        if (info && info.variants) ui.setVariants(item.id, info.variants);
        else ui.setVariants(item.id, []);
      },
      onClear: async () => {
        if (tabId == null) return;
        await send({ type: 'mg:clear', tabId });
        refresh();
      },
      onRefresh: () => refresh(),
      onToggleRemux: (v) => send({ type: 'mg:settings', patch: { remux: v } }),
      onCancel: async (jobId) => {
        await send({ type: 'mg:cancel', tabId, jobId });
        refresh();
      },
    });

    if (tabId == null) {
      ui.setNotice('当前标签页不能嗅探（可能是浏览器内部页面）。', 0);
    }
    await refresh();
    pollTimer = setInterval(refresh, 900);
  }

  window.addEventListener('unload', () => clearInterval(pollTimer));

  // 设置项写回后台
  function bindSetting(id, key, read) {
    const node = document.getElementById(id);
    if (!node) return;
    node.addEventListener('change', async () => {
      await send({ type: 'mg:settings', patch: { [key]: read(node) } });
      refresh();
    });
  }

  bindSetting('folder', 'folder', (n) => n.value.trim());
  bindSetting('concurrency', 'concurrency', (n) => Number(n.value) || 4);
  bindSetting('referer', 'useReferer', (n) => n.checked);
  bindSetting('autoclose', 'autoCloseSaver', (n) => n.checked);

  init();
})();
