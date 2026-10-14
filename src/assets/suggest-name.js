'use strict';
/**
 * src/assets/suggest-name.js —— R1-F7 建议名（**只建议，绝不重命名**）
 *
 * PRD 明确：自动改名会破坏美术工作流与已有引用，所以本模块**只产出建议字符串**，
 * 写进 map.json 供人参考，任何代码路径都不会去动用户的文件名。
 *
 * 命名规则（形态 + 尺寸 + 色相）：
 *   panel_bg_720x420     常规面板 / 九宫格候选
 *   btn_capsule_200x56   胶囊（单轴九宫格）
 *   icon_round_64x64     圆形图标（禁切）
 *   fx_radial_128x128    放射纹理（禁切）
 *   img_128x64           形态不明的兜底
 *
 * 色相后缀便于人工在缩略图里快速区分：warm/red 系用 _warm，冷色用 _cool。
 */

const { VERDICT } = require('../imaging/grid9');

/**
 * 按主色粗分色相族。
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string} warm | cool | neutral | dark
 */
function colorFamily(r, g, b) {
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 'na';
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const lum = (r + g + b) / 3;
  if (lum < 40) return 'dark';
  if (sat < 0.15) return 'neutral';
  // 色相：0=红 60=黄 120=绿 180=青 210=蓝 270=紫 330=品红
  let hue;
  const mx = max;
  const d = mx - min;
  if (d === 0) hue = 0;
  else if (mx === r) hue = ((g - b) / d) % 6;
  else if (mx === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  if (hue >= 20 && hue < 70) return 'warm';   // 黄橙
  if (hue >= 70 && hue < 170) return 'cool';   // 绿青
  if (hue >= 170 && hue < 260) return 'cool';  // 蓝
  if (hue >= 260 && hue < 330) return 'warm';  // 紫品
  return 'warm';                               // 红
}

/**
 * 生成建议名。
 *
 * @param {Object} args
 * @param {string} args.relPath
 * @param {Object} args.features AssetFeatures
 * @param {Object} [args.grid9] Grid9VerdictResult
 * @returns {string} 形如 `panel_bg_720x420`，无特征时返回原 basename
 */
function suggestName(args) {
  const f = args.features;
  if (!f) {
    // 没特征就给个安全兜底：保留原名（**不猜测形态**）
    return String(args.relPath || '').replace(/\.[^.]+$/, '');
  }

  const w = f.w;
  const h = f.h;
  const family = colorFamily(f.dominantR, f.dominantG, f.dominantB);
  const g = args.grid9;

  // 形态词：以九宫格判定为主，辅以尺寸比例与边缘特征
  let shape;
  if (g && g.verdict === VERDICT.CAN_9GRID) {
    shape = f.aspectRatio >= 1.8 ? 'bar_bg' : 'panel_bg';
  } else if (g && g.verdict === VERDICT.SINGLE_AXIS_ONLY) {
    shape = 'btn_capsule';
  } else if (g && g.verdict === VERDICT.NEVER) {
    // NEVER 里再细分：圆形 / 放射 / 其他
    const nearSquare = f.aspectRatio >= 0.85 && f.aspectRatio <= 1.18;
    if (f.radialSymmetry > 0.88 && nearSquare) {
      shape = family === 'dark' || (f.edgeDensity || 0) > 0.3 ? 'fx_radial' : 'icon_round';
    } else if (nearSquare) {
      shape = 'icon_round';
    } else {
      shape = 'fx_radial';
    }
  } else {
    shape = 'img';
  }

  const parts = [shape, `${w}x${h}`];
  if (family !== 'na' && family !== 'neutral') parts.push(family);
  return parts.join('_');
}

module.exports = { suggestName, colorFamily };
