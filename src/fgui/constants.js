'use strict';
/**
 * src/fgui/constants.js —— FGUI 契约常量表（P1-a-01 / ARCHITECTURE §2.2）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 本文件的设计原则：所有值都是「默认值」，全部可从 fgui.config.json 覆盖 ★
 *
 *   ★ UPSTREAM-FIX-2（外部审查修复）★：Q18（displayList 合法标签清单）已依据
 *   上游 STANDARDS.md §2.6 落定 —— 合法标签只有 10 种（image/graph/loader/
 *   loader3D/text/richtext/list/component/jta/group）；Q19（extention 8 种）
 *   已核对与上游一致。剩余外部依赖：Q2（包 id 是否稳定 8 位）/
 *   Q20（命名禁用词表）。
 *   猜错的代价是「误拦合法组件」—— 所以默认值以已核实的上游规范为准，
 *   合作方版本如有差异只改 fgui.config.json 的 fgui 段，**不改本文件、不改任何代码**。
 *
 *   与 P0 的 grid9 阈值完全同构（src/imaging/grid9.js 的 DEFAULT_THRESHOLDS
 *   ↔ fgui.config.json 的 grid9 段），由 determinism.test.js 的配置守卫
 *   与 lint-rules.test.js 的守卫自检双重保证「配置真的在读、不是硬编码」。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ★ 上游拼写警告 ★
 *   字段名拼写是 `extention`（不是 extension）—— 这是上游 FairyGUI 的拼写，
 *   本文件的常量名与字符串值都保持原样，**不要「顺手修正」**（HANDOFF-P1 §2.5）。
 */

// ════════════════════════════════════════════════════════════════════════════
// 一、displayList 合法标签表（R-01 的依据）
// ════════════════════════════════════════════════════════════════════════════
//
// ★ UPSTREAM-FIX-2：依据上游 STANDARDS.md §2.6（外部审查逐句核对）★
//   displayList 的合法标签**只有 10 种**。Q18 的剩余疑问仅是「合作方版本
//   是否与上游有差异」，不再是「这 10 个是什么」—— 如合作方版本确有出入，
//   仍只改 fgui.config.json 的 fgui 段，不改本文件。
//
// 三个高频发明错误（STANDARDS 原文预警，R-01 拦截 + 教正确写法）：
//   ❌ <inputtext>/<input>  —— 输入框的正确写法是
//      <text input="true" prompt="请输入"/>（ObjectType 叫 InputText，
//      但 XML 标签就是 text + input 属性）
//   ❌ <movieclip>          —— 序列帧动画的正确写法是 <jta src="ui://..."/>；
//      movieclip 只在 package.xml 里作资源登记标签，**不上舞台**
//   3D/骨骼内容用 <loader3D/>
//
// 对应 GObject 类型：
//   image     GImage        picture
//   graph     GGraph        几何图形
//   loader    GLoader       装载器（动态换图）
//   loader3D  GLoader3D     3D/骨骼内容装载
//   text      GTextField    文本（静态；input="true" 时即输入框 GTextInput）
//   richtext  GRichTextField 富文本
//   list      GList         列表
//   component GComponent    嵌套组件引用
//   jta       —             序列帧动画（JTA）
//   group     GGroup        分组（逻辑容器，无像素）
const DISPLAY_LIST_TAGS = Object.freeze([
  'image', 'graph', 'loader', 'loader3D', 'text', 'richtext', 'list', 'component', 'jta', 'group',
]);

// ════════════════════════════════════════════════════════════════════════════
// 二、extention 合法值表（R-02 的依据）
// ════════════════════════════════════════════════════════════════════════════
//
// 默认值 = 上游 STANDARDS 记录的 8 种。
//   ★ UPSTREAM-FIX-2 核对结论：上游与现有值一致
//   （Button/Label/ComboBox/ProgressBar/Slider/ScrollBar/List/Tree），不改。
const EXTENTION_TYPES = Object.freeze([
  'Button', 'Label', 'ComboBox', 'ProgressBar', 'Slider', 'ScrollBar', 'List', 'Tree',
]);

// ════════════════════════════════════════════════════════════════════════════
// 三、包 id 与 id 序列（R-04 / R-07 的依据）
// ════════════════════════════════════════════════════════════════════════════

// 包 id 位数。默认 8 —— 上游 README：create_package「包 id 由编辑器分配，
// 必须是 8 位」。**Q2 未确认**（问 package.xml 包 id 是否稳定 8 位）。
// 上游事故：6 位包 id 会吃掉 itemId 首字符，27 图 + 组件静默丢失。
const PKG_ID_LENGTH = 8;

// 显示对象 id 前缀（b / c）与序号位数（000NN = 5 位）。
// 上游 STANDARDS 的 id 序列规范：b000NN / c000NN。
const ID_PREFIXES = Object.freeze(['b', 'c']);
const ID_DIGITS = 5;

// ════════════════════════════════════════════════════════════════════════════
// 四、颜色格式（R-03 的依据）
// ════════════════════════════════════════════════════════════════════════════
//
// ★ 上游实测（v0.1.1，已核实事实）★
//   `#RRGGBBAA` 运行时**只取后 6 位**：`#000000c8` 渲染成纯蓝 (0,0,200)。
//   所以颜色必须是 6 位，透明度走独立的 `alpha="0.x"` 属性。
//   src/psd/text-extract.js 的 rgbToHex6 同样遵守这条（永不输出 8 位色）。
//
//   ⚠ 措辞纪律（QA 第三轮记录）：上游 README 原文对「只取后 6 位」用的是
//   **hedged 表述（「可能」）**，本常量注释与 R-03 报错文案写成确定性表述 ——
//   依据是工程师实测（`#000000c8`→纯蓝）而非上游措辞。若 Q 系列答案给出
//   反例，改这里与 R-03 文案。
const COLOR_HEX6_RE = /^#[0-9a-fA-F]{6}$/;
const COLOR_HEX8_RE = /^#[0-9a-fA-F]{8}$/;

// ════════════════════════════════════════════════════════════════════════════
// 五、lint 运行期配置默认值（fgui.config.json 的 fgui 段默认值）
// ════════════════════════════════════════════════════════════════════════════
//
// ★ 与 src/core/config.js 的 defaultConfig().fgui 必须逐键一致（含值）★
//   由 test/unit/lint-rules.test.js 的「配置守卫」断言保证。
//   为什么在两处各写一份：§8.6 模块边界约定「core 不得 import 上层」——
//   core/config.js 不能 require fgui/constants.js，只能各写一份 + 测试对账
//   （与 grid9 阈值同款模式：config.js 与 grid9.js 各一份，determinism.test.js 对账）。
//
// 键名即配置项名，改 fgui.config.json 的 fgui 段即可覆盖，无需改代码。
const DEFAULT_FGUI_CONFIG = Object.freeze({
  // R-01：displayList 合法标签（依据上游 STANDARDS.md §2.6；
  //       Q18 仅需确认合作方版本是否有差异，有出入时改 fgui.config.json）
  displayListTags: DISPLAY_LIST_TAGS,
  // R-02：extention 合法值（依据上游 STANDARDS.md §2.6 核对，与上游一致）
  extentionTypes: EXTENTION_TYPES,
  // R-04：ui:// 包 id 位数（Q2 未确认 → 默认 8）
  pkgIdLength: PKG_ID_LENGTH,
  // R-07：id 序列前缀与位数
  idPrefixes: ID_PREFIXES,
  idDigits: ID_DIGITS,
  // R-03：颜色属性名清单 + 是否强制 alpha 属性
  //   colorRequireAlpha 默认 false：FairyGUI 省略 alpha 合法（默认 1.0），
  //   强制要求会误拦合法 XML。上游规范是否强制「每个颜色都显式写 alpha」
  //   尚未确认（见 fgui.config.json 注释），故默认关、可开。
  colorAttributes: Object.freeze(['color', 'strokeColor', 'fillColor']),
  colorRequireAlpha: false,
  // R-04：承载 ui:// 引用的属性名清单
  urlAttributes: Object.freeze(['src', 'url', 'icon', 'defaultItem']),
  // R-04：**需要做引用合法性校验**的属性名清单（含 `font`）。
  //   ★ 与 urlAttributes 的区别（两者不可混用）★
  //     · urlAttributes      = 「哪些属性指向一个**可测量尺寸的资源**」—— R-05（scale9grid
  //                            边界对账）与 R-10（九宫格适用性）靠它找"这个元素引用的图"；
  //     · uiRefAttributes    = 「哪些属性里的 ui:// 需要做**引用合法性校验**」—— 只有 R-04 用。
  //   真实 FairyGUI 6.1.4 工程的字体引用是 `font="ui://mtlga5qj8yoa8k"`（拼接），
  //   需要校验；但 `font` 若塞进 urlAttributes，会让 `<text font="ui://…">` 被 R-05/R-10
  //   当成"引用了一张图"去量宽高 → 误报。故单独一份清单。
  uiRefAttributes: Object.freeze(['src', 'url', 'icon', 'defaultItem', 'font']),
  // R-06：组件是否必须 exported="true"（上游事故：漏则发布静默丢包）
  exportedRequired: true,
  // R-09：单组件显示对象数告警阈值（上游 STANDARDS，可调）
  maxObjectsPerComponent: 80,
  // R-08：语义命名禁用模式（Q20 未确认 → 默认只拦明显无语义的）
  //   默认表刻意保守：只拦 n0/n1/img1/node/纯数字 这类生成器默认名。
  //   图层自动名（图层1/矩形1）是否也禁，等 Q20 答案再往配置里加。
  bannedNamePatterns: Object.freeze(['^n\\d+$', '^img\\d+$', '^node\\d*$', '^\\d+$']),
  // R-10：九宫格适用性 lint 开关（复用 src/imaging/grid9.js，阈值走 grid9 配置段）
  grid9LintEnabled: true,
});

/**
 * 由配置构造 id 合法性正则。
 *
 * @param {string[]} prefixes 合法前缀（如 ['b','c']）
 * @param {number} digits 序号位数（如 5 → 000NN）
 * @returns {RegExp} 形如 /^[bc]\d{5}$/
 */
function buildIdPattern(prefixes, digits) {
  const list = Array.isArray(prefixes) && prefixes.length ? prefixes : ID_PREFIXES;
  const n = Number.isFinite(digits) && digits > 0 ? Math.floor(digits) : ID_DIGITS;
  const group = list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^[${group}]\\d{${n}}$`);
}

module.exports = {
  DISPLAY_LIST_TAGS,
  EXTENTION_TYPES,
  PKG_ID_LENGTH,
  ID_PREFIXES,
  ID_DIGITS,
  COLOR_HEX6_RE,
  COLOR_HEX8_RE,
  DEFAULT_FGUI_CONFIG,
  buildIdPattern,
};
