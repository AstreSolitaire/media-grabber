// 面板功能的断言集合：体积显示、媒体/图片分页、缩略图、全屏预览。
// 单独放一个文件，免得把测试脚本本身撑得太长。扩展端与用户脚本端共用。

export async function runPanelAssertions({ page, check, sleep, waitFor, swSession }) {
  /** 面板要先展开才会去探测流媒体的体积（扩展端不会自动弹，需要用户点一下按钮）。 */
  const ensureOpen = () =>
    page.eval(`(function(){
      var sr = document.querySelector('#mg-host').shadowRoot;
      var panel = sr.querySelector('.mg-panel');
      if (panel && panel.hidden) {
        var fab = sr.querySelector('.mg-fab');
        if (fab) fab.click();
      }
      return true;
    })()`);

  await ensureOpen();

  // 体积来源排查用：资源时间线里到底有没有 transferSize
  if (process.env.MG_DEBUG_SIZES === '1') {
    const perf = await page.eval(
      `JSON.stringify(performance.getEntriesByType('resource').map(function(e){ return { n: e.name.split('/').pop(), t: e.transferSize, b: e.encodedBodySize, i: e.initiatorType }; }))`
    );
    console.log('  [诊断] 资源时间线:', perf);
  }

  // ---------------------------------------------- 每个资源都要有文件大小
  const sizes = await waitFor(
    async () => {
      const v = await page.eval(`(function(){
        var host = document.querySelector('#mg-host');
        if (!host || !host.shadowRoot) return null;
        var rows = host.shadowRoot.querySelectorAll('.mg-item');
        if (!rows.length) return null;
        return JSON.stringify([].map.call(rows, function(r){
          var m = r.querySelector('.mg-meta');
          var s = r.querySelector('.mg-size');
          var n = r.querySelector('.mg-name');
          return {
            name: n ? n.textContent : '',
            size: s ? s.textContent : '',
            url: m ? (m.getAttribute('title') || '') : '',
            meta: m ? m.textContent : ''
          };
        }));
      })()`);
      const rows = JSON.parse(v || 'null');
      if (!rows) return null;
      const hls = rows.filter((r) => /\.m3u8$/i.test(r.url));
      // 等 HLS 的自动探测出结果
      if (hls.some((r) => !r.size || r.size === '统计中…')) return null;
      return rows;
    },
    { timeout: 40000, label: '体积信息补齐' }
  ).catch(async (e) => {
    // 体积没补齐时，把后台的报错打出来（扩展端的请求是在 Service Worker 里发的）
    if (swSession) {
      const NL = String.fromCharCode(10) + '            ';
      const errs = swSession.errors();
      console.log('  后台报错:', errs.length ? NL + errs.slice(0, 5).join(NL) : '(无)');
      const rows = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        return JSON.stringify([].map.call(sr.querySelectorAll('.mg-item'), function(r){
          return { n: (r.querySelector('.mg-name')||{}).textContent || '', m: (r.querySelector('.mg-meta')||{}).textContent || '' };
        }));
      })()`);
      console.log('  当前列表:', rows);
    }
    throw e;
  });

  check(
    '每个资源下面都显示了文件大小',
    sizes.every((r) => r.size && r.size.length > 0),
    sizes.map((r) => `${r.name}=${r.size}`).join(' | ')
  );

  const hlsEst = sizes.filter((r) => /\.m3u8$/i.test(r.url) && /约/.test(r.size));
  check(
    'HLS 显示的是「约 X」预估体积，而不是播放列表本身那几百字节',
    hlsEst.length >= 2 && hlsEst.every((r) => !/^约 \d+ B$/.test(r.size)),
    hlsEst.map((r) => `${r.name}→${r.size}`).join(' | ')
  );
  check(
    '条目里带了时长',
    sizes.some((r) => /\d+:\d\d/.test(r.meta)),
    sizes.find((r) => /\d+:\d\d/.test(r.meta))?.meta || '没有任何条目带时长'
  );
  check(
    '图片显示的是真实字节数（不是预估）',
    sizes.filter((r) => /\.(png|jpe?g|webp|gif)$/i.test(r.url)).every((r) => /^[\d.]+ [KM]?B$/.test(r.size)),
    sizes.filter((r) => /\.(png|jpe?g|webp|gif)$/i.test(r.url)).map((r) => `${r.name}=${r.size}`).join(' | ')
  );

  // ---------------------------------------------- 分页
  const tabs = JSON.parse(
    await page.eval(`(function(){
      var sr = document.querySelector('#mg-host').shadowRoot;
      var n = sr.querySelectorAll('.mg-tab .mg-tab-n');
      return JSON.stringify({
        media: n[0] ? n[0].textContent : '',
        image: n[1] ? n[1].textContent : ''
      });
    })()`)
  );
  check('有「媒体 / 图片」分页，图片独立计数', Number(tabs.image) >= 2, JSON.stringify(tabs));

  // ---------------------------------------------- 图片网格
  await ensureOpen();
  const grid = await waitFor(
    async () => {
      await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelectorAll('.mg-tab')[1].click()`);
      const v = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        var grid = sr.querySelector('.mg-grid');
        if (!grid || grid.hidden) return null;
        var cells = grid.querySelectorAll('.mg-thumb');
        var imgs = grid.querySelectorAll('.mg-thumb img');
        return JSON.stringify({
          cells: cells.length,
          imgs: imgs.length,
          firstSrc: imgs[0] ? imgs[0].getAttribute('src') : '',
          loading: imgs[0] ? imgs[0].getAttribute('loading') : '',
          names: [].map.call(grid.querySelectorAll('.mg-thumb-name'), function(x){ return x.textContent; }),
          sizes: [].map.call(grid.querySelectorAll('.mg-size'), function(x){ return x.textContent; }),
          showAll: (sr.querySelector('.mg-show-all') || {}).textContent || ''
        });
      })()`);
      const o = JSON.parse(v || 'null');
      return o && o.cells >= 2 && o.imgs >= 2 ? o : null;
    },
    { timeout: 20000, label: '图片网格渲染' }
  );
  check('图片页渲染出缩略图网格', grid.cells >= 2, `${grid.cells} 格：${grid.names.join(' | ')}`);
  check('缩略图是真实 img 元素且懒加载', grid.imgs >= 2 && /^https?:/.test(grid.firstSrc) && grid.loading === 'lazy', grid.firstSrc.slice(0, 70));
  check('缩略图上也标了大小', grid.sizes.some((x) => /B|KB|MB/.test(x)), grid.sizes.join(', '));
  check('极小的图标默认折叠并提供展开按钮', /显示小图标/.test(grid.showAll), grid.showAll);

  // ---------------------------------------------- 图片预览
  await ensureOpen();
  const viewer = await waitFor(
    async () => {
      await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelector('.mg-thumb img').click()`);
      const v = await page.eval(`(function(){
        var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
        if (!box || box.hidden) return null;
        var img = box.querySelector('.mg-viewer-img');
        return JSON.stringify({
          visible: true,
          hasImg: !!img,
          src: img ? img.getAttribute('src') : '',
          complete: img ? img.complete : false,
          naturalW: img ? img.naturalWidth : 0,
          title: (box.querySelector('.mg-viewer-title') || {}).textContent || '',
          meta: (box.querySelector('.mg-viewer-meta') || {}).textContent || '',
          hasDownload: !!box.querySelector('.mg-btn')
        });
      })()`);
      return JSON.parse(v || 'null');
    },
    { timeout: 20000, label: '图片预览打开' }
  );
  check('点缩略图打开全屏预览并显示图片', viewer.visible && viewer.hasImg && /^https?:/.test(viewer.src), viewer.src.slice(0, 70));
  check('预览里的图片真的加载出来了（有像素尺寸）', viewer.naturalW > 0 || viewer.complete, `naturalWidth=${viewer.naturalW}`);
  check('预览里显示文件名与大小', !!viewer.title && /B|KB|MB/.test(viewer.meta), `${viewer.title} / ${viewer.meta}`);
  check('预览里有下载按钮', viewer.hasDownload);

  await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer .mg-icon-btn').click()`);
  await sleep(400);
  const closed = await page.eval(`document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer').hidden`);
  check('预览可以关闭', closed === true);

  // ---------------------------------------------- 视频预览
  const videoViewer = await waitFor(
    async () => {
      const clicked = await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        sr.querySelectorAll('.mg-tab')[0].click();
        var rows = sr.querySelectorAll('.mg-item');
        for (var i = 0; i < rows.length; i++) {
          var m = rows[i].querySelector('.mg-meta');
          if ((m.getAttribute('title') || '').indexOf('clip.mp4') >= 0) {
            var b = rows[i].querySelector('.mg-btn-ghost');
            if (b) { b.click(); return 'clicked'; }
          }
        }
        return 'not-found';
      })()`);
      if (clicked !== 'clicked') return null;
      await sleep(800);
      const v = await page.eval(`(function(){
        var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
        var media = box.querySelector('.mg-viewer-media');
        return JSON.stringify({
          hidden: box.hidden,
          tag: media ? media.tagName : '',
          src: media ? media.getAttribute('src') : '',
          controls: media ? media.controls : false,
          readyState: media ? media.readyState : -1
        });
      })()`);
      const o = JSON.parse(v || 'null');
      return o && !o.hidden && o.tag === 'VIDEO' ? o : null;
    },
    { timeout: 20000, label: '视频预览打开' }
  );
  check(
    'mp4 能用播放器直接预览',
    videoViewer.tag === 'VIDEO' && /clip\.mp4$/.test(videoViewer.src) && videoViewer.controls,
    JSON.stringify(videoViewer)
  );

  // ---------------------------------------------- 流媒体的预览说明
  const streamHint = await waitFor(
    async () => {
      await page.eval(`(function(){
        var sr = document.querySelector('#mg-host').shadowRoot;
        var box = sr.querySelector('.mg-viewer');
        if (!box.hidden) box.querySelector('.mg-icon-btn').click();
        sr.querySelectorAll('.mg-tab')[0].click();
        var rows = sr.querySelectorAll('.mg-item');
        for (var i = 0; i < rows.length; i++) {
          var m = rows[i].querySelector('.mg-meta');
          var b = rows[i].querySelector('.mg-btn-ghost');
          if (b && /\.m3u8$/i.test(m.getAttribute('title') || '')) { b.click(); return 'ok'; }
        }
        return 'not-found';
      })()`);
      await sleep(500);
      const txt = await page.eval(`(function(){
        var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
        if (box.hidden) return null;
        var h = box.querySelector('.mg-viewer-hint');
        return h ? h.textContent : '';
      })()`);
      return txt || null;
    },
    { timeout: 20000, label: '流媒体预览提示' }
  );
  check('m3u8 预览给出明确说明，而不是空白', /下载|无法|不能/.test(streamHint), streamHint.slice(0, 70));

  await page.eval(`(function(){
    var box = document.querySelector('#mg-host').shadowRoot.querySelector('.mg-viewer');
    if (!box.hidden) box.querySelector('.mg-icon-btn').click();
  })()`);
}
