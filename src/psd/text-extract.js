'use strict';
/**
 * src/psd/text-extract.js —— R2-F2 文本图层抽取
 *
 * 抽取内容、字号、颜色、字体、对齐（对齐方式 -> FGUI align）。
 *
 * ★ 颜色硬约束（PRD §5.3 踩坑清单）★
 *   `#RRGGBBAA`（8 位色）在 FairyGUI 运行时**只取后 6 位**，
 *   `#000000c8` 会渲染成纯蓝。所以这里只输出 **6 位 `#RRGGBB`**，
 *   透明度若需要，由调用方转成 `alpha="0.x"` 属性（见 planner / P1 xml-writer）。
 *   本模块**永不**输出 8 位色。
 *
 * ★ 实测坑：文本对齐值域 ★
 *   ag-psd 读回的 `paragraphStyle.justification` 是 Photoshop 的写法，
 *   常见值有 left / center / right / justifyLeft / justifyCenter 等。
 *   FGUI 的 align 只认 left / center / right，故必须做白名单映射，
 *   未知值降级为 'left' 并在 warnings 里标注，不可静默吞。
 */

/** Photoshop justification -> FGUI align 白名单。 */
const JUSTIFICATION_MAP = Object.freeze({
  left: 'left',
  center: 'center',
  right: 'right',
  justifyLeft: 'left',
  justifyCenter: 'center',
  justifyRight: 'right',
  justifyAll: 'left',
});

/** FGUI 合法的 align 值。 */
const FGUI_ALIGN = Object.freeze(['left', 'center', 'right']);

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * 通道值转两位十六进制。
 * @param {number} v 0..255
 * @returns {string}
 */
function hex2(v) {
  const n = clamp(Math.round(v), 0, 255);
  return n.toString(16).padStart(2, '0');
}

/**
 * RGB -> `#RRGGBB`（**严格 6 位**，永不带 alpha）。
 * @param {{r:number,g:number,b:number}} c
 * @returns {string}
 */
function rgbToHex6(c) {
  if (!c) return '#000000';
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/**
 * 从文本图层抽取文本信息。
 *
 * @param {Object} layer ag-psd Layer（需带 .text）
 * @returns {{text:Object|null, warnings:Object[]}}
 *          text = { value, fontSize, color, align, font }
 */
function extractText(layer) {
  const warnings = [];
  if (!layer || !layer.text) return { text: null, warnings };

  const t = layer.text;
  const style = t.style || {};
  const value = typeof t.text === 'string' ? t.text : '';

  if (!value) {
    warnings.push({
      code: 'TEXT_UNPARSED',
      layer: layer.name || '',
      msg: `文本图层『${layer.name || ''}』内容为空，可能是未栅格化的纯文本层`,
    });
  }

  // 字号：ag-psd 给的是像素值；防御非有限数
  const rawSize = style.fontSize;
  const fontSize = Number.isFinite(rawSize) ? clamp(Math.round(rawSize), 1, 999) : 0;

  // 颜色：优先 fillColor；缺失时给 #000000 并告警（让人知道颜色没拿到，而不是猜一个）
  const fill = style.fillColor;
  let color = '#000000';
  if (fill && (Number.isFinite(fill.r) || Number.isFinite(fill.g) || Number.isFinite(fill.b))) {
    color = rgbToHex6(fill);
  } else {
    warnings.push({
      code: 'TEXT_UNPARSED',
      layer: layer.name || '',
      msg: `文本图层『${layer.name || ''}』未读到颜色信息，color 降级为 #000000（需人工确认）`,
    });
  }

  // 对齐：白名单映射，未知值降级 left
  const rawJust = (t.paragraphStyle && t.paragraphStyle.justification) || '';
  let align = JUSTIFICATION_MAP[rawJust];
  if (!align) {
    align = 'left';
    if (rawJust) {
      warnings.push({
        code: 'TEXT_UNPARSED',
        layer: layer.name || '',
        msg: `文本图层『${layer.name || ''}』对齐值 '${rawJust}' 不在已知集合内，`
          + `已降级为 'left'（FGUI 只支持 ${FGUI_ALIGN.join('/')}），需人工确认`,
      });
    }
  }

  const font = (style.font && style.font.name) || '';

  return {
    text: { value, fontSize, color, align, font },
    warnings,
  };
}

/**
 * 判断一个图层是否为文本图层。
 * @param {Object} layer
 * @returns {boolean}
 */
function isTextLayer(layer) {
  return !!(layer && layer.text && typeof layer.text === 'object');
}

module.exports = {
  extractText,
  isTextLayer,
  rgbToHex6,
  hex2,
  JUSTIFICATION_MAP,
  FGUI_ALIGN,
};
