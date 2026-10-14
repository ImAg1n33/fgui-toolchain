'use strict';
/**
 * src/assets/contact-sheet.js —— R1-F4 单文件 HTML + data: URI 内联缩略图
 *
 * 业务价值（PRD US-2）：「217 张无名切图…只需要在缩略图上点选确认」。
 * 所以这一页是整个工具链的**第一个人工介入点**，必须：
 *   · 全部缩略图内嵌（能直接发给别人 / 断网打开）
 *   · 支持按文件名 / 尺寸 / 主色 / 九宫格判定筛选
 *   · 零外部依赖（K1 禁网）
 *
 * 体积控制：超过 `--max-inline` 时降级为「不内联缩略图，只列元数据」并给出提示，
 * 而不是生成一个几百 MB 打不开的 HTML。
 */

const { writeHtml, esc, FILTER_SCRIPT } = require('../report/html-shell');
const { VERDICT } = require('../imaging/grid9');

/** 九宫格判定 -> 展示样式类。 */
const VERDICT_CLASS = Object.freeze({
  [VERDICT.CAN_9GRID]: 't-ok',
  [VERDICT.SINGLE_AXIS_ONLY]: 't-warn',
  [VERDICT.NEVER]: 't-bad',
});

/** 九宫格判定 -> 中文标签。 */
const VERDICT_LABEL = Object.freeze({
  [VERDICT.CAN_9GRID]: '可切常规九宫格',
  [VERDICT.SINGLE_AXIS_ONLY]: '仅单轴九宫格',
  [VERDICT.NEVER]: '禁切（需人工手切）',
});

/**
 * 生成 contact sheet HTML。
 *
 * @param {Object} args
 * @param {Object[]} args.assets AssetRow[]
 * @param {function(Object): Promise<string>} args.thumbOf asset -> data: URI
 * @param {Object} [args.config]
 * @param {number} [args.maxInline=5242880] 内联预算（字节）
 * @returns {Promise<{html:string, inlined:boolean, omitted:number, bytes:number}>}
 */
async function renderContactSheet(args) {
  const cfg = args.config || {};
  const maxInline = args.maxInline || (cfg.asset && cfg.asset.maxInlineBytes) || 5242880;
  // 确定性排序：按 relPath 字典序
  const assets = [...args.assets].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  // ---- 统计（顶部指标卡）----
  const byVerdict = { [VERDICT.CAN_9GRID]: 0, [VERDICT.SINGLE_AXIS_ONLY]: 0, [VERDICT.NEVER]: 0 };
  for (const a of assets) {
    const v = a.grid9 && a.grid9.verdict;
    if (v && byVerdict[v] !== undefined) byVerdict[v]++;
  }

  // ---- 缩略图（受预算约束）----
  /** @type {Map<string,string>} */
  const thumbs = new Map();
  let used = 0;
  let omitted = 0;
  for (const a of assets) {
    let uri = '';
    try {
      uri = await args.thumbOf(a);
    } catch (err) {
      // 单张缩略图失败不阻断整页
      uri = '';
    }
    const cost = uri ? uri.length : 0;
    if (uri && used + cost <= maxInline) {
      thumbs.set(a.id, uri);
      used += cost;
    } else {
      omitted++;
    }
  }

  // ---- 卡片 ----
  const cards = assets.map((a) => {
    const uri = thumbs.get(a.id) || '';
    const verdict = a.grid9 && a.grid9.verdict ? a.grid9.verdict : '';
    const cls = VERDICT_CLASS[verdict] || '';
    const label = VERDICT_LABEL[verdict] || '未判定';
    const img = uri
      ? `<img src="${uri}" alt="${esc(a.relPath)}" loading="lazy">`
      : `<div style="height:110px;display:flex;align-items:center;justify-content:center;color:#6a7285;font-size:11px">未内联</div>`;
    const rgb = a.features
      ? `rgb(${a.features.dominantR},${a.features.dominantG},${a.features.dominantB})`
      : 'n/a';
    return `<div class="item" data-name="${esc(a.relPath)}" data-verdict="${esc(verdict)}">
  ${img}
  <div class="nm">${esc(a.relPath)}</div>
  <div class="meta">${a.w}×${a.h} · 主色 <span style="display:inline-block;width:8px;height:8px;background:${rgb};border-radius:2px;vertical-align:middle"></span> ${rgb}</div>
  <div class="meta">归一名 <code>${esc(a.normName)}</code></div>
  ${verdict ? `<span class="tag ${cls}">${esc(label)}</span>` : ''}
  ${a.grid9 && a.grid9.suggestedGrid ? `<span class="tag t-warn">scale9grid="${esc(a.grid9.suggestedGrid)}"</span>` : ''}
  ${a.suggestedName ? `<div class="meta">建议名 <code>${esc(a.suggestedName)}</code>（仅供参考，不改名）</div>` : ''}
</div>`;
  }).join('\n');

  const toolbar = `<div class="toolbar">
  <input id="q" type="text" placeholder="按文件名筛选…" size="28">
  <select id="verdict">
    <option value="">全部九宫格判定</option>
    <option value="${VERDICT.CAN_9GRID}">可切常规九宫格</option>
    <option value="${VERDICT.SINGLE_AXIS_ONLY}">仅单轴九宫格</option>
    <option value="${VERDICT.NEVER}">禁切</option>
  </select>
  <span class="meta">显示 <b id="shown">${assets.length}</b> / ${assets.length}</span>
</div>`;

  const summary = {
    总数: assets.length,
    可切常规九九格: byVerdict[VERDICT.CAN_9GRID],
    仅单轴: byVerdict[VERDICT.SINGLE_AXIS_ONLY],
    禁切: byVerdict[VERDICT.NEVER],
  };

  const bodyHtml = `${toolbar}
${omitted ? `<div class="legend">⚠ 有 ${omitted} 张缩略图未内联（超出 ${Math.round(maxInline / 1024)}KB 内联预算），仅显示元数据。</div>` : ''}
<div class="grid">
${cards}
</div>`;

  const html = writeHtml;
  const { renderHtml } = require('../report/html-shell');
  const text = renderHtml({
    title: '切图 Contact Sheet',
    subtitle: 'fgui-rb 素材索引总览。缩略图全部内嵌，可离线打开、可直接转发。'
      + '九宫格判定为启发式，「禁切」表示工具不建议自动切分，需人工手切。',
    summary,
    bodyHtml,
    script: FILTER_SCRIPT,
  });

  return { html: text, inlined: thumbs.size, omitted, bytes: Buffer.byteLength(text, 'utf8') };
}

module.exports = { renderContactSheet, VERDICT_LABEL, VERDICT_CLASS };
