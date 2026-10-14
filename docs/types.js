// FGUI 工具链 —— 数据结构与接口定义（CommonJS / JSDoc 风格，便于直接落地）
// 本文件是 ARCHITECTURE.md §3 的可执行版本。类型名与 §3 类图一一对应。

'use strict';

/* ===========================================================================
 * 0. 通用约定
 * ======================================================================== */

/** @typedef {'FATAL'|'ERROR'|'WARN'|'INFO'|'DEBUG'} LogLevel */
/** @typedef {'REUSE'|'MOVE'|'RESIZE'|'RESTYLE'|'ADD'|'REMOVE'|'INFERRED'} DiffOp */
/** @typedef {'L1'|'L2'|'L3'|'L4'} MatchLevel */
/** @typedef {'CAN_9GRID'|'SINGLE_AXIS_ONLY'|'NEVER'} Grid9Verdict */
/** @typedef {'raster'|'text'|'group'|'smartobject'|'slice'} LayerType */
/** @typedef {'PNG'|'JPG'|'WEBP'} ImageFormat */

// 退出码：让小 Q 能用 PowerShell 判断「是否需要人工介入」
const EXIT = {
  OK: 0,            // 成功
  INTERNAL: 1,      // 未预期异常
  USAGE: 2,         // 参数错误
  LINT_BLOCKED: 3,  // lint 阻断，未写盘
  NEEDS_HUMAN: 4,   // 存在未确认的 INFERRED，产物已生成但不可进下一步
  ROLLED_BACK: 5,   // 写盘事务失败，已回滚
};

/* ===========================================================================
 * 1. 九宫格适用性（R1-F3）—— 启发式，禁止过度设计
 * ======================================================================== */

/**
 * @typedef {Object} AssetFeatures
 * @property {number} w
 * @property {number} h
 * @property {number} alphaRatio        不透明像素占比 0..1
 * @property {{x:number,y:number,w:number,h:number}|null} alphaBox  alpha 包围盒
 * @property {string} phash             16 位十六进制 = 64bit
 * @property {number} dominantR
 * @property {number} dominantG
 * @property {number} dominantB
 * @property {number} edgeDensity       0..1，边缘像素占比
 */

/**
 * @typedef {Object} Grid9VerdictResult
 * @property {Grid9Verdict} verdict
 * @property {number} confidence        0..1
 * @property {string[]} evidence        人类可读的判定依据（要能让人推翻结论）
 * @property {string|null} suggestedGrid  suggestedGrid9grid 值，SINGLE_AXIS_ONLY 时给出
 */

/* ===========================================================================
 * 2. R1 素材索引
 * ======================================================================== */

/**
 * @typedef {Object} AssetRow
 * @property {string} id                sha1(相对路径) 前 16 位，稳定可复现
 * @property {string} relPath           相对 asset root 的 POSIX 路径（确定性关键）
 * @property {string} baseName          不含扩展名
 * @property {string} normName          归一化名（检索主键）
 * @property {ImageFormat} format
 * @property {number} w
 * @property {number} h
 * @property {number} fileSize
 * @property {number} mtimeMs
 * @property {string} contentSha256
 * @property {AssetFeatures|null} features  纯尺寸模式下为 null
 * @property {Grid9Verdict|null} grid9
 * @property {string} suggestedName     R1-F7 只建议不重命名
 */

/**
 * @typedef {Object} SearchHit
 * @property {AssetRow} asset
 * @property {number} score             0..1
 * @property {MatchLevel} level
 * @property {number} ch1
 * @property {number} ch2
 * @property {number} ch3
 * @property {string} evidence
 * @property {boolean} confirmed        来自 map.json 的人工确认
 */

/**
 * @typedef {Object} MapEntry
 * @property {string} slot              语义槽位，如 popup_bg
 * @property {string} assetId
 * @property {string} fingerprint       contentSha256 前 16 位，用于失效检测
 * @property {string} confirmedBy
 * @property {string} confirmedAt       仅入 map.json，不进确定性产物
 */

class AssetIndex {
  /**
   * @param {{dbPath:string, assetRoot:string, thumbSize:number, logger:Logger}} opts
   */
  constructor(opts) { /* 建表 / PRAGMA / 建索引 */ }

  /** @returns {AssetIndex} */
  static open(opts) { return new AssetIndex(opts); }

  /** @param {string[]} relPaths @returns {AssetRow[]} */
  loadRows(relPaths) { throw new Error('not implemented'); }

  /** @param {AssetRow} row */
  upsert(row) { throw new Error('not implemented'); }

  /**
   * 归一化名 -> 候选行。K5 防御：同名多图时返回全部，由 sizeCheck 二次判别。
   * @param {string} normName
   * @returns {AssetRow[]}
   */
  byNormName(normName) { throw new Error('not implemented'); }

  close() {}
}

/**
 * 名称归一化。整个检索策略的地基，独立成模块。
 * 硬规则（K5）：禁止 includes / startsWith / 正则子串匹配，只允许全等。
 * @param {string} raw
 * @param {{stripCopySuffix?:boolean, variants?:Object}} [opts]
 * @returns {string}
 */
function normalizeName(raw, opts) { throw new Error('not implemented'); }

/**
 * 三通道检索。score = 0.5*Ch1 + 0.3*Ch2 + 0.2*Ch3，Ch1 命中短路置顶。
 * @param {Object} args
 * @param {AssetIndex} args.index
 * @param {string} args.queryName      IR 图层名 / 语义槽位名
 * @param {{w:number,h:number}|null} args.layerBox  图层 bbox，用于尺寸校验
 * @param {{w:number,h:number}|null} args.wantSize   期望切图尺寸
 * @param {number} [args.topK]
 * @returns {SearchHit[]}
 */
function searchAssets(args) { throw new Error('not implemented'); }

/* ===========================================================================
 * 3. R2 Design IR
 * ======================================================================== */

/**
 * @typedef {Object} LayerNode
 * @property {string} id              L001 递增，按 PSD 文档序，稳定
 * @property {string} name            画师原名
 * @property {string} normName
 * @property {string|null} parent
 * @property {LayerType} type
 * @property {{x:number,y:number,w:number,h:number}} bbox  绝对坐标
 * @property {number} rotation
 * @property {number} opacity          0..1
 * @property {boolean} visible
 * @property {string} blend
 * @property {boolean} merged          R2-F5：被画师合并，信息不可恢复
 * @property {number} childCount       >0 且 childCount===0 时疑似合并
 * @property {string|null} sliceName
 * @property {LayerText|null} text
 */

/**
 * @typedef {Object} LayerText
 * @property {string} value
 * @property {number} fontSize
 * @property {string} color           #RRGGBB，6 位（PRD §5.3 硬约束）
 * @property {string} align
 * @property {string} font
 */

/**
 * @typedef {Object} IrWarning
 * @property {string} code            MERGED_LAYER_GROUP | TEXT_UNPARSED | NO_SLICE | EMPTY_LAYER
 * @property {string} layer
 * @property {string} msg
 */

/**
 * @typedef {Object} DesignIr
 * @property {'1.0'} version
 * @property {{psdPath:string, psdSha256:string, canvas:{w:number,h:number}, dpr:number}} source
 * @property {LayerNode[]} layers      按文档序，父在子前
 * @property {IrWarning[]} warnings
 * @property {string[]} sliceNames
 */

/* ===========================================================================
 * 4. R3 ChangePlan
 * ======================================================================== */

/**
 * @typedef {Object} FguiStrategy
 * @property {'reuse'|'relation'|'scale9grid'|'gearXY'|'gearSize'|'list'|'button'|'color'|'stash'} type
 * @property {Object} [detail]
 */

/**
 * @typedef {Object} PlanDiff
 * @property {DiffOp} op
 * @property {string} slot
 * @property {string|null} node        IR layer id
 * @property {MatchLevel} matchLevel
 * @property {number} confidence
 * @property {string} evidence         必须写清「为什么这么判」
 * @property {FguiStrategy|null} fguiStrategy
 * @property {string[]} candidates     INFERRED 时的候选
 * @property {'skip'|'add'} defaultIfUnconfirmed
 * @property {Grid9Verdict|null} grid9
 */

/**
 * @typedef {Object} ChangePlan
 * @property {'1.0'} version
 * @property {{name:string, basePkg:string, targetPkg:string}} task
 * @property {{psdBase:string, psdTarget:string, fguiProject:string|null}} sources
 * @property {Record<DiffOp, number>} summary
 * @property {PlanDiff[]} diffs
 * @property {string[]} openQuestions
 */

/* ===========================================================================
 * 5. R4/P1 —— XML 生成与事务写盘（接口边界，P0 只用 lintRules）
 * ======================================================================== */

/** displayList 仅这 10 种标签合法 */
const LEGAL_TAGS = Object.freeze([
  'graph', 'image', 'text', 'richtext', 'inputtext',
  'list', 'group', 'component', 'loader', 'placeholder',
]);

/** extention 仅这 8 种合法值（注意上游拼写就是 extention，不是 extension） */
const LEGAL_EXTENTIONS = Object.freeze([
  'Button', 'Label', 'ComboBox', 'ProgressBar',
  'Slider', 'ScrollBar', 'List', 'Tree',
]);

/**
 * @typedef {Object} LintProblem
 * @property {string} rule             如 COLOR_NOT_6_DIGIT
 * @property {'error'|'warn'|'info'} severity
 * @property {string} where            文件:节点
 * @property {string} msg              中文
 * @property {string} [fix]            可执行的修复建议
 */

/**
 * 纯函数：输入文本，输出问题列表。不碰文件系统，因此 P0 就能单测。
 * @param {string} xml
 * @param {{pkgIdLength?:number, maxObjects?:number}} [opts]
 * @returns {LintProblem[]}
 */
function lintComponentXml(xml, opts) { throw new Error('not implemented'); }

/**
 * 事务化写盘。临时文件 -> lint -> 备份 -> 原子替换 -> 失败回滚。
 */
class FsTransaction {
  /**
   * @param {{targetPath:string, content:string, validator:Function, logger:Logger}} opts
   */
  constructor(opts) { throw new Error('not implemented'); }

  /** @returns {{applied:boolean, backupPath:string|null, problems:LintProblem[]}} */
  commit() { throw new Error('not implemented'); }

  /** @returns {{restored:boolean, backupPath:string}} */
  rollback() { throw new Error('not implemented'); }
}

/* ===========================================================================
 * 6. R5 桥客户端（P1，接口预留，产品主链路不依赖）
 * ======================================================================== */

class BridgeClient {
  /** @param {{port?:number, bridgeUrl?:string, project?:string, timeoutMs?:number}} opts */
  constructor(opts) {}

  /** 如实上报可用性。OpenDocument / screenshot 必须 try-catch 实调，不做真值守卫。 */
  async probe() { throw new Error('not implemented'); }

  async ping() { throw new Error('not implemented'); }
  async readComponent(pkg, name) { throw new Error('not implemented'); }
  async refresh() { throw new Error('not implemented'); }
}

module.exports = {
  EXIT, LEGAL_TAGS, LEGAL_EXTENTIONS,
  normalizeName, searchAssets, lintComponentXml,
  AssetIndex, FsTransaction, BridgeClient,
};
