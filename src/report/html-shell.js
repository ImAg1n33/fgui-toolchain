'use strict';
/**
 * src/report/html-shell.js —— 单文件 HTML 模板（零构建、零 CDN、零网络请求）
 *
 * PRD K1 强制：产物 HTML 里**不允许有任何外部引用**（无 CDN、无外链字体、无远程图片）。
 * 缩略图一律 `data:` URI 内联，交互一律内联原生 JS。
 *
 * 确定性（B9）：
 *   · 无时间戳
 *   · 资源按稳定键排序
 *   · 缩略图 base64 由 sharp 确定性编码产生（同输入两次编码逐字节一致，已实测）
 */

const { writeText } = require('../core/fs-json');

/** HTML 转义。 */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染一个单文件 HTML。
 *
 * @param {Object} args
 * @param {string} args.title
 * @param {string} args.subtitle
 * @param {string} args.bodyHtml 已在调用方拼好的 body
 * @param {string} [args.script] 内联 JS（原生，无框架）
 * @param {string} [args.style] 内联 CSS 追加
 * @param {Object} [args.summary] 顶部指标卡片
 * @returns {string} 完整 HTML 文本
 */
function renderHtml(args) {
  const cards = (args.summary && Object.keys(args.summary).length)
    ? `<div class="cards">${Object.keys(args.summary).sort().map((k) => `
      <div class="card">
        <div class="card-k">${esc(k)}</div>
        <div class="card-v">${esc(args.summary[k])}</div>
      </div>`).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(args.title)}</title>
<style>
:root {
  --bg: #14161c; --panel: #1c1f28; --line: #2b3040;
  --fg: #e6e9f0; --dim: #98a0b3; --accent: #6ea8fe;
  --ok: #5cc98a; --warn: #e6b455; --bad: #e2687a;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 20px 24px 60px;
  background: var(--bg); color: var(--fg);
  font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
.sub { color: var(--dim); font-size: 13px; margin-bottom: 16px; }
.offline {
  display: inline-block; margin-bottom: 14px; padding: 3px 10px;
  border: 1px solid var(--line); border-radius: 4px;
  color: var(--dim); font-size: 12px;
}
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
.card {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 6px; padding: 8px 14px; min-width: 96px;
}
.card-k { color: var(--dim); font-size: 11px; text-transform: uppercase; }
.card-v { font-size: 18px; font-weight: 600; margin-top: 2px; }
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
input[type=text], select {
  background: var(--panel); color: var(--fg);
  border: 1px solid var(--line); border-radius: 4px;
  padding: 6px 10px; font-size: 13px;
}
.grid { display: flex; flex-wrap: wrap; gap: 12px; }
.item {
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 8px; width: 168px;
}
.item.hide { display: none; }
.item img {
  width: 100%; height: 110px; object-fit: contain;
  background:
    repeating-conic-gradient(#22252e 0% 25%, #1a1d24 0% 50%) 50% / 14px 14px;
  border-radius: 4px; display: block;
}
.nm { font-size: 12px; margin-top: 6px; word-break: break-all; line-height: 1.35; }
.meta { color: var(--dim); font-size: 11px; margin-top: 3px; }
.tag {
  display: inline-block; padding: 1px 6px; border-radius: 3px;
  font-size: 10px; margin-top: 4px; margin-right: 4px;
  border: 1px solid var(--line);
}
.t-ok { color: var(--ok); border-color: var(--ok); }
.t-warn { color: var(--warn); border-color: var(--warn); }
.t-bad { color: var(--bad); border-color: var(--bad); }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td {
  border: 1px solid var(--line); padding: 5px 8px;
  text-align: left; vertical-align: top;
}
th { background: var(--panel); color: var(--dim); font-weight: 600; }
code { background: #11131a; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
svg { background: #0f1116; border: 1px solid var(--line); border-radius: 6px; max-width: 100%; }
.hoverable { cursor: pointer; }
.hoverable:hover { stroke-width: 2.5; }
.legend { color: var(--dim); font-size: 12px; margin: 8px 0; }
${args.style || ''}
</style>
</head>
<body>
<h1>${esc(args.title)}</h1>
<div class="sub">${esc(args.subtitle || '')}</div>
<div class="offline">离线产物 · 无外部引用 · 本页不发起任何网络请求</div>
${cards}
${args.bodyHtml}
<script>
${args.script || ''}
</script>
</body>
</html>
`;
}

/**
 * 渲染并落盘。
 * @param {string} outPath
 * @param {Object} args renderHtml 的参数
 * @returns {{path:string, bytes:number}}
 */
function writeHtml(outPath, args) {
  return writeText(outPath, renderHtml(args));
}

/** 原生筛选脚本（零依赖，约 20 行）。 */
const FILTER_SCRIPT = `
(function () {
  var q = document.getElementById('q');
  var verdict = document.getElementById('verdict');
  var items = Array.prototype.slice.call(document.querySelectorAll('.item'));
  function apply() {
    var needle = (q && q.value || '').trim().toLowerCase();
    var vf = verdict && verdict.value || '';
    var shown = 0;
    items.forEach(function (el) {
      var name = (el.getAttribute('data-name') || '').toLowerCase();
      var vd = el.getAttribute('data-verdict') || '';
      var okN = !needle || name.indexOf(needle) >= 0;
      var okV = !vf || vd === vf;
      var show = okN && okV;
      el.classList.toggle('hide', !show);
      if (show) shown++;
    });
    var c = document.getElementById('shown');
    if (c) c.textContent = shown;
  }
  if (q) q.addEventListener('input', apply);
  if (verdict) verdict.addEventListener('change', apply);
  apply();
})();
`;

module.exports = { renderHtml, writeHtml, esc, FILTER_SCRIPT };
