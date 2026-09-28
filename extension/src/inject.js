// 在页面主世界（MAIN world）运行的嗅探脚本。
// HLS/m3u8 地址通常藏在播放器的 JS 里，页面用 blob: URL 喂给 <video>，
// 所以光看 DOM 是抓不到的，必须拦一下 fetch / XHR。
// 所有钩子都必须保证不改变原有行为，任何异常都吞掉，绝不能弄坏页面。

(function () {
  if (window.__mgSnifferInstalled) return;
  window.__mgSnifferInstalled = true;

  const MARK = '__mg_sniff__';
  let alive = true;

  function post(payload) {
    if (!alive) return;
    try {
      window.postMessage({ __mg: MARK, ...payload }, '*');
    } catch {
      /* 忽略 */
    }
  }

  // fetch
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          let url = '';
          let method = 'GET';
          if (typeof input === 'string') url = input;
          else if (input && typeof input.url === 'string') {
            url = input.url;
            method = input.method || 'GET';
          }
          if (init && init.method) method = init.method;
          if (url) post({ url, via: 'fetch', method });
        } catch {
          /* 忽略 */
        }
        return origFetch.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  // XMLHttpRequest（hls.js / dash.js 都走这条）
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
      const origOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        try {
          if (typeof url === 'string') post({ url, via: 'xhr', method });
        } catch {
          /* 忽略 */
        }
        return origOpen.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  // 资源时间线：<video src>、媒体元素内部请求都会留下记录，而且能拿到大小
  try {
    if (typeof PerformanceObserver === 'function') {
      const po = new PerformanceObserver((list) => {
        try {
          for (const e of list.getEntries()) {
            if (!e || !e.name) continue;
            post({
              url: e.name,
              via: 'perf',
              size: e.transferSize || e.encodedBodySize || 0,
              initiator: e.initiatorType || '',
            });
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

  // 直接写在标签上的地址
  const IMAGE_NAME_RE = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|svg|ico|heic|heif)(\?|$)/i;
  const MEDIA_NAME_RE = /\.(mp3|mp4|m4a|m4v|m3u8|webm|flac|wav|ogg|opus|mkv|mov|avi|ts)(\?|$)/i;
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-actualsrc', 'data-echo'];

  /** 从 srcset 里挑最后一个候选（通常尺寸最大）。 */
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
        if (src) post({ url: src, via: 'dom' });
        const poster = n.getAttribute && n.getAttribute('poster');
        if (poster) post({ url: poster, via: 'dom-poster' });
      }

      // 图片：已加载的用 currentSrc，没加载的看懒加载属性
      let budget = 120;
      const imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
      for (const img of imgs) {
        if (budget-- <= 0) break;
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (src) post({ url: src, via: 'dom-img', w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
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
          if (lazy && IMAGE_NAME_RE.test(lazy)) post({ url: lazy, via: 'dom-img-lazy' });
        }
      }

      const links = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
      for (const a of links) {
        const href = a.getAttribute('href');
        if (href && (MEDIA_NAME_RE.test(href) || IMAGE_NAME_RE.test(href))) {
          post({ url: href, via: 'dom-link' });
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  try {
    scanDom(document);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => scanDom(document), { once: true });
    }
    // 后面动态插入的播放器
    if (typeof MutationObserver === 'function' && document.documentElement) {
      let scheduled = false;
      const mo = new MutationObserver((records) => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          for (const r of records) {
            for (const n of r.addedNodes || []) {
              if (n.nodeType === 1) scanDom(n);
            }
          }
        }, 300);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      // 页面关闭时别留着观察器
      window.addEventListener('pagehide', () => {
        alive = false;
        try {
          mo.disconnect();
        } catch {
          /* 忽略 */
        }
      });
    }
  } catch {
    /* 忽略 */
  }
})();
