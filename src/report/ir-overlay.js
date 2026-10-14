'use strict';
/**
 * src/report/ir-overlay.js —— R2-F6 可视化校验图
 *
 * 业务价值（PRD R2-F6「成本极低、价值极高」）：把 IR 的 bbox 画在效果图上，
 * 人一眼就能看出解析对不对。**这是解析结果的人工验收手段** ——
 * 没有它，A5「PSD 解析准确率 100% 正确」根本无从验证。
 *
 * 产物：单文件 HTML + 内联 base64 PNG + SVG <rect> 叠加。
 * 零外部依赖、零网络请求（PRD K1）。
 */

const path = require('path');
const fs = require('fs');
const { esc } = require('./html-shell');
const { round6, sortBy } = require('../core/determinism');
const { compositeImageData } = require('../psd/reader');

/**
 * 借用 sharp 把合成图编码成 PNG（不自己实现 PNG 编码）。
 * @param {{width:number,height:number,data:Uint8ClampedArray}} imageData
 * @returns {Promise<string>} data: URI
 */
async function compositeToDataUri(imageData) {
  const sharp = require('sharp');
  const buf = await sharp(Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength), {
    raw: { width: imageData.width, height: imageData.height, channels: 4 },
  }).png({ compressionLevel: 9, effort: 4 }).toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * 生成 SVG 叠加层。
 *
 * @param {Object[]} layers IR 图层
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {string} SVG 文本
 */
function buildOverlaySvg(layers, canvasW, canvasH) {
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${canvasW} ${canvasH}" width="${canvasW}" height="${canvasH}" `
    + `xmlns="http://www.w3.org/2000/svg">`);

  // 图层按 id 排序（确定性）
  const sorted = sortBy(layers, (l) => l.id);
  for (const l of sorted) {
    const b = l.bbox;
    if (!b || b.w <= 0 || b.h <= 0) continue;
    // 颜色按类型区分；merged 组用醒目虚线
    const color = l.type === 'group'
      ? (l.merged ? '#e2687a' : '#6ea8fe')
      : l.type === 'text' ? '#5cc98a' : '#e6b455';
    const dash = l.type === 'group' ? (l.merged ? 'stroke-dasharray="6 4"' : 'stroke-dasharray="3 3"') : '';
    parts.push(`<rect class="hoverable" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" `
      + `fill="none" stroke="${color}" stroke-width="1.5" ${dash}>`
      + `<title>${esc(l.id)} ${esc(l.name)} [${esc(l.type)}] `
      + `${b.x},${b.y} ${b.w}x${b.h} (${esc(l.bboxSource)})`
      + `${l.merged ? ' MERGED' : ''}${l.sliceName ? ` slice=${esc(l.sliceName)}` : ''}</title>`
      + `</rect>`);
    // 顶层节点标名，避免图上糊成一团
    if (!l.parent && l.type !== 'group') {
      parts.push(`<text x="${b.x + 2}" y="${b.y - 3}" fill="${color}" font-size="10" `
        + `font-family="Consolas,monospace">${esc(l.name)}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * ★ 校验合成底图是否真的可用 ★
 *
 * 这道校验的存在理由（QA BUG #2 逼出来的）：
 *   `ir_overlay.html` 的**唯一用途**是让小 Q 把 bbox 叠在效果图上人工核对。
 *   如果底图是一张全黑图，他看到的是「黑底 + 彩色框」——
 *   **框对不对他无从判断**，但页面「看起来完全正常」（能打开、框能画）。
 *   这类「静默给错东西」比明确报错危害大得多：**明确报错**至少让人知道不能信。
 *
 *   已实测过的真实事故：合成 PSD 若未提供 `psd.imageData`，
 *   `ag-psd` 的 writer 会写出一张全黑图，读回来 RGB 非黑像素 0%（alpha 却是 255，
 *   所以「alpha 非零」这种断言查不出来）。
 *
 * 因此这里做两件事：
 *   ① 检测退化（全黑 / 全透明 / 只有一种颜色）-> 页面顶部**显著红色警告**
 *   ② 若退化，**不放底图**（避免误导），只显示 bbox + 说明
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}|null} composite
 * @returns {{usable:boolean, reason:string, stats:{nonBlackRatio:number, alphaRatio:number, distinctColors:number}}}
 */
function validateComposite(composite) {
  const stats = { nonBlackRatio: 0, alphaRatio: 0, distinctColors: 0 };
  if (!composite || !composite.data || composite.width <= 0 || composite.height <= 0) {
    return { usable: false, reason: '未能从 PSD 读出合成预览图（可能是以 structure 模式解析，或 PSD 未内嵌预览图）', stats };
  }
  const total = composite.width * composite.height;
  const colors = new Set();
  let nonBlack = 0;
  let opaque = 0;
  // 采样上限：超大图全量扫太慢，按步长抽样（结果只用于「是否退化」的判定，不进产物）
  const stride = total > 400000 ? 4 : 1;
  let sampled = 0;
  for (let i = 0; i < composite.data.length; i += 4 * stride) {
    sampled++;
    const r = composite.data[i];
    const g = composite.data[i + 1];
    const b = composite.data[i + 2];
    const a = composite.data[i + 3];
    if (r || g || b) nonBlack++;
    if (a >= 128) opaque++;
    // 量化到 5bit 再计数，避免浮点/antialias 造成「颜色数」虚高
    if (colors.size < 64) colors.add(`${r >> 3},${g >> 3},${b >> 3},${a >> 3}`);
  }
  stats.nonBlackRatio = round6(nonBlack / Math.max(1, sampled));
  stats.alphaRatio = round6(opaque / Math.max(1, sampled));
  stats.distinctColors = colors.size;

  // ================= 判定分两级（QA P2-2）=================
  // ★ 关键区分：「退化失败」vs「信息量少但合法」 ★
  //
  //   退化失败（degenerate）—— 底图**内容是错的**，必须拦截：
  //     · 全黑但 alpha 不透明  -> ag-psd 没拿到 imageData（原 BUG#2）
  //     · 全透明              -> 什么都没解出来
  //     这两种「看起来正常」（能开、框能画）但内容全错，属最坏的一类静默错误。
  //
  //   信息量少（lowInfo）—— 底图**是对的**，只是内容简单：
  //     · 单色图（纯色底框 / 纯色按钮 / 纯色图标）
  //     判 NEVER 会造成误报：QA 实测「纯色底框 + 纯色按钮 = 2 色」是真实最常见形态，
  //     而**纯色单图**（1 色）在真实素材里也 legitimately 存在（纯色分割线、纯色占位块）。
  //     拦掉它没有收益 —— 人仍然能拿它核对 bbox 是否贴合，只是核对信息少一点。
  //   故改为：放行 + 附一条**提示**（不阻断，不隐藏）。
  //
  //   误报边界实测（QA P2-2）：
  //     全黑1色=拦截 ✅ / 全透明1色=拦截 ✅ / 纯白单色=原误报 ⚠️ / 两色=放行 ✅ / 三色=放行 ✅

  // ★ 判定顺序：先看 alpha，再看 RGB ★
  //   全透明图的 nonBlackRatio 也是 0（既没颜色也没不透明像素），
  //   若先判「全黑」会报出「alpha 却有 0% 不透明」这种自相矛盾的话 ——
  //   排查的人会照着错误文案去查错方向。故 alpha 优先。
  if (stats.alphaRatio < 0.001) {
    return {
      usable: false,
      kind: 'degenerate',
      reason: `合成预览图为**全透明**（不透明像素 ${(stats.alphaRatio * 100).toFixed(2)}%），`
        + '什么都没解出来，无法作为核对底图。请改用 mode=full 重新解析。',
      stats,
    };
  }
  if (stats.nonBlackRatio < 0.001) {
    return {
      usable: false,
      kind: 'degenerate',
      reason: `合成预览图实测为**全黑**（RGB 非黑像素 ${(stats.nonBlackRatio * 100).toFixed(2)}%，`
        + `却有 ${(stats.alphaRatio * 100).toFixed(0)}% 像素不透明）—— `
        + '这是「看起来正常但内容全错」的典型情形（原 BUG#2），故**不显示底图**。'
        + '请确认该 PSD 是否内嵌了预览图；若未内嵌，需在写入端提供 psd.imageData。',
      stats,
    };
  }
  if (stats.distinctColors <= 1) {
    // ★ 不再拦截：单色图是合法内容，只是核对信息量少 ★
    return {
      usable: true,
      kind: 'lowInfo',
      reason: '',
      note: `合成预览图为**单色**（仅 1 种颜色）—— 底图内容正确，`
        + '但核对信息量较少：可以用它确认 bbox 的**相对位置与层级**，'
        + '无法据此确认**绝对尺寸**是否贴合设计稿。'
        + '（这不是错误：纯色底框/按钮/分割线在真实素材里就是单色。）',
      stats,
    };
  }
  return { usable: true, kind: 'ok', reason: '', note: '', stats };
}

/**
 * 生成 ir_overlay.html。
 *
 * @param {Object} args
 * @param {Object} args.ir Design IR
 * @param {Object} [args.psd] ag-psd 解析结果（提供合成图；缺省则不画底图）
 * @param {string} [args.title]
 * @returns {Promise<{html:string, bytes:number, layerCount:number, hasBaseImage:boolean,
 *                    compositeUsable:boolean, compositeWarning:string}>}
 */
async function renderIrOverlay(args) {
  const ir = args.ir;
  const canvasW = (ir.source && ir.source.canvas && ir.source.canvas.w) || 0;
  const canvasH = (ir.source && ir.source.canvas && ir.source.canvas.h) || 0;
  const layers = ir.layers || [];

  // ---- 底图（合成图）：先校验再用，绝不假设它可用 ----
  const composite = args.psd ? compositeImageData(args.psd) : null;
  const check = validateComposite(composite);
  let baseImg = '';
  const hasBaseImage = check.usable;
  if (check.usable) {
    try {
      baseImg = await compositeToDataUri(composite);
    } catch (err) {
      baseImg = '';
    }
  }
  // 编码失败也算不可用，但理由要说清
  const compositeWarning = check.usable && !baseImg
    ? '合成预览图编码为 PNG 失败，已省略底图，仅显示 bbox。'
    : check.reason;
  // ★ 低信息量（单色图）：底图**照常显示**，只附一条提示（QA P2-2）★
  const compositeNote = check.usable && check.kind === 'lowInfo' ? (check.note || '') : '';
  const compositeUsable = check.usable && !!baseImg;

  const svg = buildOverlaySvg(layers, canvasW, canvasH);
  const bodyHtml = `
${compositeWarning ? `<div style="background:#3a1c22;border:1px solid #e2687a;border-radius:6px;padding:10px 14px;margin-bottom:14px">
  <div style="color:#e2687a;font-weight:600;margin-bottom:4px">⚠ 合成底图不可用 —— 本页只能看 bbox，无法与效果图比对</div>
  <div style="color:#d8b0b8;font-size:13px;line-height:1.6">${esc(compositeWarning)}</div>
  <div style="color:#d8b0b8;font-size:13px;margin-top:4px">下列 bbox 仍按 IR 解析结果绘制，可核对<b>层级与相对位置</b>，但<b>无法核对绝对位置</b>是否贴合设计稿。</div>
</div>` : ''}
${compositeNote ? `<div style="background:#33291a;border:1px solid #e6b455;border-radius:6px;padding:8px 14px;margin-bottom:14px">
  <div style="color:#e6b455;font-size:13px;line-height:1.6">ℹ ${esc(compositeNote)}</div>
</div>` : ''}
<div class="toolbar">
  <input id="q" type="text" placeholder="按图层名筛选…" size="28">
  <select id="verdict">
    <option value="">全部类型</option>
    <option value="group">组 group</option>
    <option value="raster">位图 raster</option>
    <option value="text">文本 text</option>
  </select>
  <span class="meta">显示 <b id="shown">${layers.length}</b> / ${layers.length} 个图层</span>
</div>
<div class="legend">
  图例：
  <span style="color:#6ea8fe">▭</span> 组（虚线）　
  <span style="color:#e2687a">▭</span> 已合并组（红色虚线，⚠ 子层信息不可恢复）　
  <span style="color:#e6b455">▭</span> 位图　
  <span style="color:#5cc98a">▭</span> 文本
  ${hasBaseImage
    ? `　底图：已内联合成预览图（非黑像素 ${(check.stats.nonBlackRatio * 100).toFixed(1)}%，色数 ${check.stats.distinctColors}`
      + `${check.kind === 'lowInfo' ? '，单色图核对信息有限' : ''}）`
    : '　<b style="color:#e2687a">底图：不可用</b>'}
</div>
<div style="position:relative;display:inline-block;max-width:100%;border:1px solid #2b3040;border-radius:6px;overflow:hidden">
  ${hasBaseImage ? `<img src="${baseImg}" style="display:block;max-width:100%;height:auto" alt="合成图">` : ''}
  ${svg}
</div>
<table style="margin-top:16px">
  <thead><tr><th>id</th><th>名称</th><th>类型</th><th>bbox</th><th>bboxSource</th><th>merged</th><th>slice</th><th>父</th></tr></thead>
  <tbody>
  ${sortBy(layers, (l) => l.id).map((l) => `<tr class="row" data-name="${esc(l.name)}" data-verdict="${esc(l.type)}">
    <td><code>${esc(l.id)}</code></td>
    <td>${esc(l.name)}</td>
    <td>${esc(l.type)}</td>
    <td><code>${l.bbox.x},${l.bbox.y} ${l.bbox.w}x${l.bbox.h}</code></td>
    <td>${esc(l.bboxSource)}${l.bboxSource === 'derived' ? ' <span class="tag t-warn">子层并集</span>' : ''}</td>
    <td>${l.merged ? '<span class="tag t-bad">MERGED</span>' : ''}</td>
    <td>${l.sliceName ? `<code>${esc(l.sliceName)}</code>` : ''}</td>
    <td>${l.parent ? `<code>${esc(l.parent)}</code>` : '-'}</td>
  </tr>`).join('\n  ')}
  </tbody>
</table>
<h2 style="font-size:15px;margin-top:20px">解析告警（${(ir.warnings || []).length}）</h2>
${(ir.warnings || []).length ? `<ul>${ir.warnings.map((w) => `<li><code>${esc(w.code)}</code> @ <code>${esc(w.layer)}</code> — ${esc(w.msg)}</li>`).join('')}</ul>` : '<p class="meta">无告警</p>'}
<h2 style="font-size:15px;margin-top:20px">导出切片（${(ir.slices || []).length}）</h2>
${(ir.slices || []).length ? `<ul>${ir.slices.map((s) => `<li><code>${esc(s.name)}</code> → 图层 <code>${esc(s.layer || '-')}</code>，rect ${s.rect.x},${s.rect.y} ${s.rect.w}x${s.rect.h}</li>`).join('')}</ul>` : '<p class="meta">未检测到切片（L1 最强匹配通道不可用，见 PRD Q7）</p>'}
`;

  const summary = {
    图层总数: layers.length,
    组: layers.filter((l) => l.type === 'group').length,
    位图: layers.filter((l) => l.type === 'raster').length,
    文本: layers.filter((l) => l.type === 'text').length,
    已合并组: layers.filter((l) => l.merged).length,
    告警: (ir.warnings || []).length,
    切片: (ir.slices || []).length,
  };

  const script = `
(function () {
  var q = document.getElementById('q');
  var t = document.getElementById('verdict');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
  function apply() {
    var needle = (q && q.value || '').trim().toLowerCase();
    var tf = t && t.value || '';
    var shown = 0;
    rows.forEach(function (el) {
      var n = (el.getAttribute('data-name') || '').toLowerCase();
      var v = el.getAttribute('data-verdict') || '';
      var show = (!needle || n.indexOf(needle) >= 0) && (!tf || v === tf);
      el.style.display = show ? '' : 'none';
      if (show) shown++;
    });
    var c = document.getElementById('shown');
    if (c) c.textContent = shown;
  }
  if (q) q.addEventListener('input', apply);
  if (t) t.addEventListener('change', apply);
  apply();
})();
`;

  const title = args.title || `IR 校验图 · ${ir.source ? path.basename(ir.source.psdPath) : ''}`;
  const { renderHtml } = require('./html-shell');
  const html = renderHtml({
    title,
    subtitle: '把 Design IR 的 bbox 叠加在 PSD 合成图上。'
      + '若框位与画师所见一致，说明解析正确；红框虚线为被合并的组（子层信息不可恢复）。'
      + '鼠标悬停任意框可见图层名与坐标。',
    summary,
    bodyHtml,
    script,
  });

  return {
    html,
    bytes: Buffer.byteLength(html, 'utf8'),
    layerCount: layers.length,
    hasBaseImage: compositeUsable,
    compositeUsable,
    compositeWarning,
    compositeNote,
    compositeKind: check.kind,
  };
}

module.exports = { renderIrOverlay, buildOverlaySvg, validateComposite };
