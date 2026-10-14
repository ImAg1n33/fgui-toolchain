'use strict';
/**
 * src/core/variants.js —— 繁简 / 异体字映射表（ARCHITECTURE D8）
 *
 * 为什么不用 OpenCC：Node 侧没有轻量方案，引词典会显著增大依赖与失败面。
 * 本轮用**可配置映射表**，默认内置常用字；词典缺失时降级为「不做转换」，
 * 并由调用方在 evidence 里标注（降级是可见的，不是静默的）。
 *
 * 扩展方式：把新的映射对象传给 normalizeName({variants: {...}})，或替换本文件默认表。
 */

/**
 * 默认繁简对照表（常用字，覆盖游戏 UI 文案高频字）。
 * 键 = 繁体/异体，值 = 简体。缺失的字不做转换（降级）。
 * @type {Object<string,string>}
 */
const DEFAULT_VARIANTS = Object.freeze({
  // 顶部高频
  個: '个', 們: '们', 這: '这', 說: '说', 對: '对', 時: '时', 會: '会', 沒: '没',
  來: '来', 後: '后', 東: '东', 車: '车', 馬: '马', 鳥: '鸟', 魚: '鱼', 龍: '龙',
  // 界面 / 交互
  開: '开', 關: '关', 門: '门', 問: '问', 間: '间', 聞: '闻', 語: '语', 話: '话',
  詳: '详', 情: '情', 誤: '误', 認: '认', 為: '为', 讓: '让', 請: '请', 謝: '谢',
  買: '买', 賣: '卖', 貨: '货', 質: '质', 費: '费', 資: '资', 賽: '赛', 獎: '奖',
  // 状态
  勝: '胜', 敗: '败', 級: '级', 獎: '奖', 勳: '勋', 稱: '称', 稱: '称', 態: '态',
  狀: '状', 現: '现', 實: '实', 應: '应', 該: '该', 樣: '样', 數: '数', 據: '据',
  // 奖励 / 邮件场景
  獎: '奖', 勵: '励', 禮: '礼', 郵: '邮', 郵: '邮', 詳: '详', 細: '细', 題: '题',
  領: '领', 取: '取', 寶: '宝', 貝: '贝', 鑽: '钻', 幣: '币', 頁: '页', 頭: '头',
  結: '结', 束: '束', 員: '员', 總: '总', 數: '数', 組: '组', 織: '织', 網: '网',
  // 顏色 / 圖形
  圖: '图', 形: '形', 圓: '圆', 角: '角', 線: '线', 條: '条', 寬: '宽', 高: '高',
  紅: '红', 綠: '绿', 藍: '蓝', 黃: '黄', 灰: '灰', 邊: '边', 內: '内', 區: '区',
  // 動詞 / 常用
  點: '点', 擊: '击', 開: '开', 始: '始', 結: '结', 束: '束', 完: '完', 成: '成',
  設: '设', 定: '定', 選: '选', 擇: '择', 確: '确', 認: '认', 檢: '检', 查: '查',
  顯: '显', 示: '示', 隱: '隐', 藏: '藏', 儲: '储', 存: '存', 讀: '读', 寫: '写',
  執: '执', 行: '行', 發: '发', 現: '现', 過: '过', 還: '还', 經: '经', 過: '过',
});

/**
 * 应用繁简映射。
 * @param {string} text
 * @param {Object<string,string>} [table]
 * @returns {{text:string, applied:boolean, tableSize:number}}
 *          applied=false 表示词典为空/未启用 —— 调用方应在 evidence 里标注降级
 */
function applyVariants(text, table) {
  const map = table && typeof table === 'object' ? table : DEFAULT_VARIANTS;
  const keys = Object.keys(map);
  if (!keys.length) return { text, applied: false, tableSize: 0 };
  let applied = false;
  let out = '';
  for (const ch of String(text)) {
    if (Object.prototype.hasOwnProperty.call(map, ch)) {
      out += map[ch];
      applied = true;
    } else {
      out += ch;
    }
  }
  return { text: out, applied, tableSize: keys.length };
}

/**
 * 判断字符串是否含「词典可能覆盖」的繁体字（用于 evidence 提示，不做转换决策）。
 * @param {string} text
 * @param {Object<string,string>} [table]
 * @returns {boolean}
 */
function hasVariants(text, table) {
  const map = table && typeof table === 'object' ? table : DEFAULT_VARIANTS;
  for (const ch of String(text)) {
    if (Object.prototype.hasOwnProperty.call(map, ch)) return true;
  }
  return false;
}

module.exports = { DEFAULT_VARIANTS, applyVariants, hasVariants };
