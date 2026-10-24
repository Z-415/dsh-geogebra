/**
 * dsh-geogebra · HTML 模板
 *
 * 交给无头 Edge 加载的那一页。它不负责"导出图片"（这个版本的 GeoGebra 5.4 导出 API 全坏，
 * 见 lib/cdp.mjs 顶部的说明），只负责三件事：
 *   ① 加载 deployggb.js → new GGBApplet(params) → inject
 *   ② appletOnLoad 里逐条 evalCommand(命令)，把每条的成功/失败 + getValueString 结果记进 window.__ggb
 *   ③ 暴露 window.__ggb.viewRect()，让宿主知道该截图的图形区矩形
 *
 * 页面从不自己截屏：用 `--screenshot` + virtual-time 那条路实测会饿死帧生产（图是空的）。
 * 宿主用 CDP 实时等待 window.__ggb.status 变成 ok/err，再 Page.captureScreenshot 裁剪。
 */

/** 让任意字符串安全地嵌进 <script>。 */
function jsValue(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @param {object} opts
 * @param {string[]} [opts.commands]
 * @param {number}  [opts.width]
 * @param {number}  [opts.height]
 * @param {boolean} [opts.transparent]
 * @param {boolean} [opts.axes]
 * @param {boolean} [opts.grid]
 * @param {string}  [opts.language]
 * @param {boolean} [opts.evalOnly]  只要命令结果，不要图
 * @param {boolean} [opts.needGgb]   额外把整份构造导出成 .ggb 的 base64（GeoGebra 可直接打开）
 * @returns {string} 完整 HTML
 */
export function buildHtml(opts) {
  const {
    commands = [],
    width = 1000,
    height = 700,
    transparent = false,
    axes = true,
    grid = true,
    language = 'zh',
    evalOnly = false,
    needGgb = false,
  } = opts ?? {};

  const cfg = JSON.stringify({
    commands: Array.isArray(commands) ? commands.map((c) => String(c)) : [],
    width: Math.round(Number(width) || 1000),
    height: Math.round(Number(height) || 700),
    axes: axes !== false,
    grid: grid !== false,
    evalOnly: Boolean(evalOnly),
    needGgb: Boolean(needGgb),
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-geogebra</title>
<script src="https://www.geogebra.org/apps/deployggb.js"
        onerror="(window.__ggb=window.__ggb||{status:'err',results:[],error:null,notes:[]}).status='err';window.__ggb.error='deployggb.js 拉取失败：需要联网访问 https://www.geogebra.org/apps/deployggb.js'"></script>
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: ${transparent ? 'transparent' : '#ffffff'}; }
  #ggb-element { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; margin: 0; padding: 0; }
</style>
</head>
<body>
<div id="ggb-element"></div>
<script>
window.__ggb = {
  status: 'loading',
  results: [],
  error: null,
  notes: [],
  /** .ggb（ZIP）的 base64；needGgb 时由 getBase64() 取出 */
  ggbBase64: null,
  ggbError: null,

  /** 最大画布 = 图形区。返回 CSS 像素矩形，宿主按它裁剪截图。 */
  viewRect: function () {
    var best = null, bestArea = 0;
    var cs = document.getElementsByTagName('canvas');
    for (var i = 0; i < cs.length; i++) {
      var r = cs[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = { x: r.left, y: r.top, width: r.width, height: r.height,
                 pixelWidth: cs[i].width, pixelHeight: cs[i].height };
      }
    }
    return best;
  }
};

(function () {
  var CFG = ${cfg};

  function fail(message) {
    window.__ggb.status = 'err';
    window.__ggb.error = String(message);
  }

  // 标签推导：f(x)=x^3-3x -> f ；T=Tangent(1,f) -> T ；A=(1,-2) -> A
  function labelOf(command) {
    var i = command.indexOf('=');
    if (i < 0) { return null; }
    var left = command.slice(0, i).trim();
    var m = /^([A-Za-z][A-Za-z0-9_]*)\\s*(\\([^)]*\\))?$/.exec(left);
    return m ? m[1] : null;
  }

  function readValue(api, command) {
    var label = labelOf(command);
    if (!label) { return null; }
    try {
      var v = api.getValueString(label);
      return (v === undefined || v === null) ? null : String(v);
    } catch (e) { return null; }
  }

  window.addEventListener('load', function () {
    if (typeof GGBApplet !== 'function') {
      fail('deployggb.js 没加载成功：需要联网访问 https://www.geogebra.org/apps/deployggb.js。'
        + '断网时这个工具用不了，请联网后重试。');
      return;
    }

    var params = {
      appName: 'classic',
      width: CFG.width,
      height: CFG.height,
      // perspective:'G' 只留图形视图 —— 这是本版本唯一真正关掉代数区的开关
      // （showAlgebraView:false 在 5.4.920 里被忽略）
      perspective: 'G',
      showToolBar: false,
      showMenuBar: false,
      showAlgebraInput: false,
      showAlgebraView: false,
      showZoomButtons: false,
      showFullscreenButton: false,
      showResetIcon: false,
      showSuggestionBar: false,
      showGrid: CFG.grid,
      showAxes: CFG.axes,
      showClipping: false,
      avoidFocus: true,
      enableRightClick: false,
      enableLabelDrags: false,
      language: 'zh',
      appletOnLoad: function (api) {
        try {
          // 命令写错时 GeoGebra 默认弹模态错误框，会把整页卡死
          if (typeof api.setErrorDialogsActive === 'function') { api.setErrorDialogsActive(false); }
        } catch (e) { window.__ggb.notes.push('setErrorDialogsActive: ' + e.message); }

        try { api.setPerspective('G'); } catch (e) { window.__ggb.notes.push('setPerspective: ' + e.message); }

        var results = [];
        var failed = [];
        for (var i = 0; i < CFG.commands.length; i++) {
          var cmd = CFG.commands[i];
          var ok = false;
          var errText = null;
          try {
            ok = api.evalCommand(cmd) !== false;
          } catch (e) {
            ok = false;
            errText = String(e && e.message ? e.message : e);
          }
          results.push({
            index: i,
            command: cmd,
            ok: ok,
            value: ok ? readValue(api, cmd) : null,
            error: errText,
          });
          if (!ok) { failed.push(cmd); }
        }
        window.__ggb.results = results;

        if (failed.length) {
          fail('GeoGebra 拒绝了这些命令：' + failed.join(' ; '));
          return;
        }

        // 整份构造导出成 .ggb：GeoGebra 的 getBase64() 直接给 ZIP 的 base64，
        // 宿主解码后原样落盘就是能双击/在 GeoGebra 里打开的可编辑文件。
        if (CFG.needGgb) {
          try {
            var b64 = null;
            if (typeof api.getBase64 === 'function') { b64 = api.getBase64(); }
            if (typeof b64 === 'string' && b64.length > 16) {
              window.__ggb.ggbBase64 = b64;
            } else {
              window.__ggb.ggbError = '这个 GeoGebra 版本没有返回 .ggb 数据（getBase64 不可用）';
            }
          } catch (e) {
            window.__ggb.ggbError = '导出 .ggb 失败：' + (e && e.message ? e.message : e);
          }
        }

        window.__ggb.status = 'ok';
      },
    };

    try {
      new GGBApplet(params, true).inject('ggb-element');
    } catch (e) {
      fail('GGBApplet 注入失败：' + (e && e.message ? e.message : e));
    }

    // 看门狗：路由资源下下来了却迟迟不回调，就明确报错，别让宿主干等到超时
    setTimeout(function () {
      if (window.__ggb.status === 'loading') {
        fail('GeoGebra 应用没有初始化完成（appletOnLoad 未回调）：'
          + '通常是 GeoGebra 运行资源下载太慢。请联网后重试，或把 timeoutMs 提到 120000。');
      }
    }, 45000);
  });
})();
</script>
</body>
</html>`;
}

export default { buildHtml };
