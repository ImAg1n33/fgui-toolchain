'use strict';
/**
 * src/create/exec-plan.js —— CREATE Executor 地基：`create_plan.json` → **可执行 Bridge 操作清单**
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 为什么先做"清单"而不是直接调 Bridge ★
 *   本机没有 FairyGUI / Unity（PRD K2），Executor 无法本地验证。若直接写成
 *   "只有朋友那台机器能跑"的脚本，我们只能盲写。所以这一步只把 plan 翻译成
 *   **确定性、可人工审阅、可交给朋友执行**的步骤清单（create_exec.json）：
 *     建容器 → 按 layer 升序插节点 → 保存 → **回读校验**。
 *   本模块**不联网、不调 Bridge、不写任何 FGUI 文件**（纯函数）。
 *
 * ★ 四道硬约束（第七轮审查要求，违反即 bug）★
 *   1. **词表封闭**：命令名只能来自 `BRIDGE_COMMANDS`（= docs/BRIDGE-COMMANDS.md）。
 *      词表外 → `unsupported`，**绝不编造命令名**。
 *   2. **参数 Schema**：光有名字不够。每个 op 的必填/类型按同一份词表校验；
 *      不合规 → **`invalidSteps`**（与 `unsupported` 语义不同：有命令但参数不合规）。
 *   3. **禁止假成功**：`executable` 只有在「preflight.ok && 无 required 的 unsupported
 *      && 无 invalidSteps」时才为 true。只要有必需操作没落成，就**不许**对外说构建完成。
 *   4. **结果回读**：步骤末尾追加 `verify`（用词表里真实存在的回读命令），
 *      并写 `onMismatch:"fail"` —— 命令 ok ≠ 做对了。
 * ════════════════════════════════════════════════════════════════════════════
 */

const { AppError, CODES } = require('../core/errors');

/** 产物版本（执行清单自己的格式版本；本轮加了 schema/preflight/verify → 0.2）。 */
const EXEC_VERSION = '0.2';

/** 参数类型取值。 */
const T = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  OBJECT: 'object',
  ARRAY: 'array',
});

/**
 * Bridge 命令词表 —— **以 docs/plugin_main.js.baseline + mcp_server.mjs.baseline 为准**
 * （详见 `docs/BRIDGE-COMMANDS.md`）。**这是唯一真源**：
 * `COMMAND_SCHEMA` 由它派生，禁止另抄一份（防止两处漂移）。
 *
 * `params.required` / `params.optional` / `params.types` 对应文档里的「参数」列；
 * 文档未列参数的无参命令 → 空数组。
 */
const BRIDGE_COMMANDS = Object.freeze({
  discover_projects: {
    writes: false, needsEditor: false, use: '探测在线工程', params: { required: [], optional: [], types: {} },
  },
  ping: {
    writes: false, needsEditor: true, use: '探活', params: { required: [], optional: [], types: {} },
  },
  project_info: {
    writes: false, needsEditor: true, use: '当前工程信息', params: { required: [], optional: [], types: {} },
  },
  list_packages: {
    writes: false, needsEditor: true, use: '包列表', params: { required: [], optional: [], types: {} },
  },
  list_items: {
    writes: false,
    needsEditor: true,
    use: '包内资源树',
    params: { required: ['pkg'], optional: ['depth'], types: { pkg: T.STRING, depth: T.NUMBER } },
  },
  read_component: {
    writes: false,
    needsEditor: true,
    use: '读组件 XML',
    params: { required: ['pkg', 'name'], optional: [], types: { pkg: T.STRING, name: T.STRING } },
  },
  list_children: {
    writes: false,
    needsEditor: true,
    use: '列舞台子节点',
    params: { required: ['pkg', 'name'], optional: [], types: { pkg: T.STRING, name: T.STRING } },
  },
  open_doc: {
    writes: false,
    needsEditor: true,
    use: '打开组件文档',
    params: { required: ['pkg', 'name'], optional: [], types: { pkg: T.STRING, name: T.STRING } },
  },
  close_doc: {
    writes: false,
    needsEditor: true,
    use: '关闭组件文档',
    params: { required: ['pkg', 'name'], optional: [], types: { pkg: T.STRING, name: T.STRING } },
  },
  bridge_log: {
    writes: false,
    needsEditor: true,
    use: '插件日志',
    params: { required: [], optional: ['tail'], types: { tail: T.NUMBER } },
  },
  create_package: {
    writes: true,
    needsEditor: true,
    use: '建包',
    params: { required: ['name'], optional: [], types: { name: T.STRING } },
  },
  create_component: {
    writes: true,
    needsEditor: true,
    use: '建组件（Page 也是组件）',
    params: {
      required: ['pkg', 'name', 'width', 'height'],
      optional: ['path', 'extention', 'exported'],
      types: {
        pkg: T.STRING, name: T.STRING, width: T.NUMBER, height: T.NUMBER,
        path: T.STRING, extention: T.STRING, exported: T.BOOLEAN,
      },
    },
  },
  delete_item: {
    writes: true,
    needsEditor: true,
    use: '删资源项',
    params: { required: ['pkg', 'name'], optional: [], types: { pkg: T.STRING, name: T.STRING } },
  },
  set_image_scale9: {
    writes: true,
    needsEditor: true,
    use: '库内图片标九宫格',
    params: {
      required: ['pkg', 'name'],
      optional: ['scale9grid', 'left', 'top', 'width', 'height', 'overwrite'],
      types: {
        pkg: T.STRING, name: T.STRING, scale9grid: T.STRING,
        left: T.NUMBER, top: T.NUMBER, width: T.NUMBER, height: T.NUMBER, overwrite: T.BOOLEAN,
      },
    },
  },
  insert_object: {
    writes: true,
    needsEditor: true,
    use: '插入库内已有资源（url 或 ref_pkg+ref_name）',
    params: {
      required: ['pkg', 'name'],
      optional: ['url', 'ref_pkg', 'ref_name', 'x', 'y', 'index', 'props'],
      types: {
        pkg: T.STRING, name: T.STRING, url: T.STRING,
        ref_pkg: T.STRING, ref_name: T.STRING,
        x: T.NUMBER, y: T.NUMBER, index: T.NUMBER, props: T.OBJECT,
      },
    },
  },
  insert_text: {
    writes: true,
    needsEditor: true,
    use: '插入文本',
    params: {
      required: ['pkg', 'name', 'child'],
      optional: [
        'text', 'x', 'y', 'width', 'height', 'fontSize', 'color', 'align', 'vAlign',
        'autoSize', 'bold', 'strokeColor', 'strokeSize', 'singleLine', 'index', 'props',
      ],
      types: {
        pkg: T.STRING, name: T.STRING, child: T.STRING, text: T.STRING,
        x: T.NUMBER, y: T.NUMBER, width: T.NUMBER, height: T.NUMBER, fontSize: T.NUMBER,
        color: T.STRING, align: T.STRING, vAlign: T.STRING, autoSize: T.STRING,
        bold: T.BOOLEAN, strokeColor: T.STRING, strokeSize: T.NUMBER,
        singleLine: T.BOOLEAN, index: T.NUMBER, props: T.OBJECT,
      },
    },
  },
  insert_loader: {
    writes: true,
    needsEditor: true,
    use: '插入装载器',
    params: {
      required: ['pkg', 'name', 'child'],
      optional: ['url', 'refPkg', 'refName', 'x', 'y', 'width', 'height', 'align', 'vAlign', 'fill', 'index', 'props'],
      types: {
        pkg: T.STRING, name: T.STRING, child: T.STRING, url: T.STRING,
        refPkg: T.STRING, refName: T.STRING,
        x: T.NUMBER, y: T.NUMBER, width: T.NUMBER, height: T.NUMBER,
        align: T.STRING, vAlign: T.STRING, fill: T.STRING, index: T.NUMBER, props: T.OBJECT,
      },
    },
  },
  insert_list: {
    writes: true,
    needsEditor: true,
    use: '插入列表',
    params: {
      required: ['pkg', 'name', 'child'],
      optional: [
        'defaultItem', 'refPkg', 'layout', 'lineGap', 'colGap', 'lineItemCount',
        'overflow', 'items', 'x', 'y', 'width', 'height', 'index', 'props',
      ],
      types: {
        pkg: T.STRING, name: T.STRING, child: T.STRING,
        defaultItem: T.STRING, refPkg: T.STRING, layout: T.STRING,
        lineGap: T.NUMBER, colGap: T.NUMBER, lineItemCount: T.NUMBER,
        overflow: T.STRING, items: T.ARRAY,
        x: T.NUMBER, y: T.NUMBER, width: T.NUMBER, height: T.NUMBER,
        index: T.NUMBER, props: T.OBJECT,
      },
    },
  },
  add_controller: {
    writes: true,
    needsEditor: true,
    use: '加控制器',
    params: {
      required: ['pkg', 'name', 'controller', 'pages'],
      optional: ['selected'],
      types: {
        pkg: T.STRING, name: T.STRING, controller: T.STRING, pages: T.ARRAY, selected: T.NUMBER,
      },
    },
  },
  set_gear: {
    writes: true,
    needsEditor: true,
    use: '设置 gear',
    params: {
      required: ['pkg', 'name', 'target', 'gear', 'controller'],
      optional: ['pages', 'values', 'refPkg'],
      types: {
        pkg: T.STRING, name: T.STRING, target: T.STRING, gear: T.STRING,
        controller: T.STRING, pages: T.ARRAY, values: T.ARRAY, refPkg: T.STRING,
      },
    },
  },
  set_property: {
    writes: true,
    needsEditor: true,
    use: '改舞台子节点属性',
    params: {
      required: ['pkg', 'name', 'props'],
      optional: ['target', 'prop', 'value'],
      types: {
        pkg: T.STRING, name: T.STRING, props: T.OBJECT, target: T.STRING, prop: T.STRING,
      },
    },
  },
  remove_object: {
    writes: true,
    needsEditor: true,
    use: '移除舞台子节点',
    params: {
      required: ['pkg', 'name', 'target'],
      optional: [],
      types: { pkg: T.STRING, name: T.STRING, target: T.STRING },
    },
  },
  save_all: {
    writes: true, needsEditor: true, use: '保存所有文档', params: { required: [], optional: [], types: {} },
  },
  refresh: {
    writes: false, needsEditor: true, use: '刷新工程视图', params: { required: [], optional: [], types: {} },
  },
  publish: {
    writes: true,
    needsEditor: true,
    use: '发布包（异步）',
    params: {
      required: ['pkg'],
      optional: ['branch', 'out_path', 'timeout_ms'],
      types: { pkg: T.STRING, branch: T.STRING, out_path: T.STRING, timeout_ms: T.NUMBER },
    },
  },
  screenshot: {
    writes: true,
    needsEditor: true,
    use: '截编辑器窗口',
    params: { required: ['path'], optional: [], types: { path: T.STRING } },
  },
  // 注意：`write_component` **只在插件层存在、MCP 未暴露**，且 SKILL.md 明令不使用
  //   → 故**不**列入本词表（Executor 不得使用）。
});

/**
 * 参数 Schema —— **由 BRIDGE_COMMANDS 派生**（单一真源，禁止另抄）。
 * @type {Object<string,{required:string[],optional:string[],types:Object<string,string>}>}
 */
const COMMAND_SCHEMA = Object.freeze(
  Object.fromEntries(Object.entries(BRIDGE_COMMANDS).map(([op, v]) => [op, v.params])),
);

/** plan 的 tag → 插入它的 Bridge 命令（词表外的 tag → unsupported）。 */
const INSERT_CMD_BY_TAG = Object.freeze({
  image: 'insert_object',
  text: 'insert_text',
  loader: 'insert_loader',
  list: 'insert_list',
});

/**
 * ★ XML 属性名 → 命令参数的映射集中处 ★
 *   plan 的 `attrs` 用的是**组件 XML 属性名**（xy/size/...），而 Bridge 命令的参数名
 *   并不总与之相同（例如 `size` 在 `insert_object` 里**没有**对应参数，只能走 `props`）。
 *   **绝不能原样透传** —— 所有这类转换都写在这里，一眼可查。
 */
const ATTR_MAPPING = Object.freeze({
  /** 直接映射到同名命令参数的 attrs */
  direct: Object.freeze(['text', 'color', 'fontSize', 'align', 'vAlign', 'strokeColor', 'strokeSize', 'url', 'defaultItem', 'layout', 'overflow', 'items']),
  /** `xy:"x,y"` → `x`/`y` 两个参数 */
  xyToXy: 'xy',
  /** `size:"w,h"` → 命令无 width/height 时放进 `props.size` */
  sizeToProps: 'size',
  /** insert_text/loader/list 有 width/height 参数 → size 拆成 width/height */
  sizeToWidthHeight: 'size',
});

/** `xy:"x,y"` / `size:"w,h"` → 数值对。 */
function pair(v) {
  if (typeof v !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * 稳定排序键：先 layer（缺省 0），再 tempId。**不依赖对象键序**。
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function compareNodes(a, b) {
  const la = Number.isFinite(a.layer) ? a.layer : 0;
  const lb = Number.isFinite(b.layer) ? b.layer : 0;
  if (la !== lb) return la - lb;
  return String(a.tempId || '').localeCompare(String(b.tempId || ''));
}

/**
 * 参数类型检查。
 * @param {*} v
 * @param {string} t
 * @returns {boolean}
 */
function typeOk(v, t) {
  switch (t) {
    case T.STRING: return typeof v === 'string';
    case T.NUMBER: return typeof v === 'number' && Number.isFinite(v);
    case T.BOOLEAN: return typeof v === 'boolean';
    case T.ARRAY: return Array.isArray(v);
    case T.OBJECT: return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true; // 未声明类型 → 不拦（保持宽容，但 schema 里都会声明）
  }
}

/**
 * 按 COMMAND_SCHEMA 校验一步的参数。
 * @param {string} op
 * @param {Object} args
 * @returns {{ok:boolean, missing:string[], typeErrors:Array<{param:string,expected:string,actual:string}>}}
 */
function validateStepArgs(op, args) {
  const schema = COMMAND_SCHEMA[op];
  const a = args && typeof args === 'object' ? args : {};
  if (!schema) {
    // 词表里有 op 但没有 schema ⇒ 内部不一致（BRIDGE_COMMANDS 一定带 params）
    return { ok: false, missing: [], typeErrors: [{ param: '<schema>', expected: 'defined', actual: 'undefined' }] };
  }
  const missing = schema.required.filter((k) => a[k] === undefined || a[k] === null || a[k] === '');
  const typeErrors = [];
  for (const [k, t] of Object.entries(schema.types || {})) {
    if (a[k] === undefined || a[k] === null) continue;
    if (!typeOk(a[k], t)) typeErrors.push({ param: k, expected: t, actual: Array.isArray(a[k]) ? 'array' : typeof a[k] });
  }
  return { ok: missing.length === 0 && typeErrors.length === 0, missing, typeErrors };
}

/**
 * 把 create_plan 翻译成有序执行清单（含 preflight / invalidSteps / verify）。
 *
 * @param {Object} plan create_plan.json
 * @param {Object} [options]
 * @param {string} [options.pkgId] 目标包 8 位 id（图片插入必须用它拼 `ui://<pkgId><itemId>`）
 * @param {string[]|Set<string>} [options.vocab] 允许的命令名集合（默认 = BRIDGE_COMMANDS 的键）
 * @returns {{execPlan:Object}}
 */
function buildExecPlan(plan, options = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new AppError(CODES.BAD_ARGUMENT, 'buildExecPlan 需要 create_plan 对象');
  }
  if (!plan.page || !plan.page.name || !plan.page.pkg) {
    throw new AppError(CODES.BAD_ARGUMENT, 'create_plan.page 缺少 name/pkg');
  }
  const canvas = (plan.canvas && Number.isFinite(plan.canvas.w) && Number.isFinite(plan.canvas.h))
    ? { w: plan.canvas.w, h: plan.canvas.h }
    : (() => {
      const s = Array.isArray(plan.page.size) ? plan.page.size : null;
      if (s && Number.isFinite(s[0]) && Number.isFinite(s[1])) return { w: s[0], h: s[1] };
      throw new AppError(CODES.BAD_ARGUMENT, 'create_plan 缺少画布尺寸（canvas 或 page.size）');
    })();

  const vocab = options.vocab instanceof Set
    ? options.vocab
    : new Set(Array.isArray(options.vocab) ? options.vocab : Object.keys(BRIDGE_COMMANDS));
  const pkgId = typeof options.pkgId === 'string' && options.pkgId ? options.pkgId : null;
  const pkg = plan.page.pkg;
  const pageName = plan.page.name;

  /** @type {Object[]} */
  const steps = [];
  /** @type {Object[]} */
  const unsupported = [];
  /** @type {Object[]} */
  const invalidSteps = [];
  /** @type {Object[]} */
  const deferred = [];
  /** 已成功计划的子节点（供 verify 的 expect 推导） */
  const plannedChildren = [];

  /**
   * 尝试产出一步：先查词表，再校验参数。
   * @returns {'ok'|'no-cmd'|'invalid'}
   */
  const emit = (op, args, source, notes, required) => {
    if (!vocab.has(op)) return 'no-cmd';
    const v = validateStepArgs(op, args);
    if (!v.ok) {
      const parts = [];
      if (v.missing.length) parts.push(`缺少必填参数 ${v.missing.join('/')}`);
      for (const e of v.typeErrors) parts.push(`参数 ${e.param} 类型应为 ${e.expected}，实际 ${e.actual}`);
      invalidSteps.push({
        op, args, source, required: required !== false, missing: v.missing, typeErrors: v.typeErrors,
        reason: `${op} 参数不合规：${parts.join('；')}`,
      });
      return 'invalid';
    }
    const step = {
      step: steps.length + 1, op, args, source,
    };
    if (notes && notes.length) step.notes = notes;
    steps.push(step);
    return 'ok';
  };

  /** 记录一条 unsupported（必须显式声明 required） */
  const addUnsupported = (source, reason, required) => {
    unsupported.push({ source, reason, required: required !== false });
  };

  // ── ① 容器：Page 就是一个组件（SKILL.md：create_component 建 Comp，再同样处理 Page）──
  const pageStatus = emit('create_component', {
    pkg, name: pageName, width: canvas.w, height: canvas.h,
  }, { tempId: 'P1' }, ['P1 = 页面容器（合成 tempId，对应 plan.page）'], true);
  if (pageStatus === 'no-cmd') {
    addUnsupported({ tempId: 'P1' },
      '词表里没有 create_component —— 无法创建页面容器，后续插入无从谈起', true);
  }

  // ── ② 节点：按 layer 升序（底→顶）插入 ──
  const nodes = Array.isArray(plan.nodes) ? plan.nodes.slice() : [];
  let indexCursor = 0; // 已计划的兄弟序号 → 作为 index（z 序），跳过失败项时不会错位
  for (const node of nodes.sort(compareNodes)) {
    const tag = node && node.tag ? String(node.tag) : '';
    const tempId = node && node.tempId ? String(node.tempId) : null;
    const cmd = INSERT_CMD_BY_TAG[tag];

    if (!cmd) {
      addUnsupported({ tempId },
        `Bridge 词表里没有可插入 <${tag || '(无 tag)'}> 的命令`
        + '（基线只提供 insert_object/text/loader/list）—— 待朋友确认', true);
      continue;
    }

    const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {};
    const xy = pair(attrs.xy);
    const size = pair(attrs.size);
    const notes = [];

    let args = null;
    if (tag === 'image') {
      // insert_object 只接受 url(ui://…) 或 ref_pkg+ref_name（按**资源名**），
      // 而 plan 的 src 是**短资源 ID** → 必须由调用方给出 pkgId 才能拼 url。
      const src = typeof attrs.src === 'string' && attrs.src ? attrs.src : null;
      if (!src) {
        addUnsupported({ tempId },
          '图片节点没有 src（资源未绑定：多为 toImport / 歧义），无法插入', true);
        continue;
      }
      if (!pkgId) {
        addUnsupported({ tempId },
          `图片 src='${src}' 是短资源 ID，而 insert_object 只接受 ui:// url`
          + '（基线里没有"按资源 id 插入"的命令）—— 需要调用方提供包 id（pkgId）'
          + '才能拼 ui://<pkgId><itemId>', true);
        continue;
      }
      args = { pkg, name: pageName, url: `ui://${pkgId}${src}`, index: indexCursor };
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      // ★ ATTR_MAPPING.sizeToProps：insert_object 没有 width/height 参数 → props.size
      const props = {};
      if (size) props.size = `${size[0]},${size[1]}`;
      if (Object.keys(props).length) args.props = props;
      if (!xy) notes.push('缺少 xy：insert_object 未给坐标，由编辑器默认放置');
    } else if (tag === 'text') {
      args = { pkg, name: pageName, child: node.name || tempId, index: indexCursor };
      if (typeof attrs.text === 'string') args.text = attrs.text;
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      // ★ ATTR_MAPPING.sizeToWidthHeight：insert_text 有 width/height 参数
      if (size) { args.width = size[0]; args.height = size[1]; }
      for (const k of ATTR_MAPPING.direct) {
        if (attrs[k] === undefined || ['text', 'url', 'defaultItem', 'layout', 'overflow', 'items'].includes(k)) continue;
        args[k] = k === 'fontSize' || k === 'strokeSize' ? Number(attrs[k]) : attrs[k];
      }
      // 其余 attrs 没有对应具名参数 → 走 props，绝不静默丢弃
      const mapped = new Set(['xy', 'size', ...ATTR_MAPPING.direct]);
      const rest = {};
      for (const k of Object.keys(attrs)) if (!mapped.has(k)) rest[k] = attrs[k];
      if (Object.keys(rest).length) {
        args.props = rest;
        notes.push(`未具名映射的 attrs 已放进 props：${Object.keys(rest).join(',')}`);
      }
      if (attrs.estimated === true) notes.push('attrs.estimated=true：含估计值，需人工确认');
    } else if (tag === 'loader') {
      args = { pkg, name: pageName, child: node.name || tempId, index: indexCursor };
      if (typeof attrs.url === 'string') args.url = attrs.url;
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      if (size) { args.width = size[0]; args.height = size[1]; }
    } else if (tag === 'list') {
      args = { pkg, name: pageName, child: node.name || tempId, index: indexCursor };
      if (attrs.defaultItem !== undefined) args.defaultItem = attrs.defaultItem;
      if (attrs.layout !== undefined) args.layout = attrs.layout;
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      if (size) { args.width = size[0]; args.height = size[1]; }
    }

    const status = emit(cmd, args, { tempId }, notes, true);
    if (status === 'ok') {
      indexCursor += 1;
      plannedChildren.push({
        name: node.name || tempId,
        xy: typeof attrs.xy === 'string' ? attrs.xy : null,
        size: typeof attrs.size === 'string' ? attrs.size : null,
      });
    } else if (status === 'no-cmd') {
      addUnsupported({ tempId },
        `词表里没有 ${cmd}（本次词表被裁剪或被上游移除），无法插入 <${tag}>`, true);
    }
    // status === 'invalid' → 已记入 invalidSteps（required=true），不需要额外 unsupported
  }

  // ── ③ 保存 ──
  const saveStatus = emit('save_all', {}, { tempId: null }, undefined, true);
  if (saveStatus === 'no-cmd') {
    addUnsupported({ tempId: null }, '词表里没有 save_all —— 所有编辑都不会落盘', true);
  }

  // ── ④ deferred：v1 明确「只给建议、不自动生成」（不是 unsupported，但可见）──
  const d = plan.deferred && typeof plan.deferred === 'object' ? plan.deferred : {};
  for (const key of ['controllers', 'relations', 'listItems']) {
    const arr = Array.isArray(d[key]) ? d[key] : [];
    if (!arr.length) continue;
    deferred.push({
      kind: key,
      count: arr.length,
      reason: `create_plan 标记为 deferred（v1 只给建议，不自动生成 ${key}）：`
        + '如需执行请在后续版本显式开启，本清单不包含这些步骤',
    });
  }

  // ── ⑤ 结果回读（verify）：命令 ok ≠ 做对了 ──
  const verify = [];
  const siblings = plannedChildren.map((c) => (c.size ? { name: c.name, xy: c.xy, size: c.size } : { name: c.name, xy: c.xy }));
  if (vocab.has('read_component')) {
    verify.push({
      op: 'read_component',
      args: { pkg, name: pageName },
      expect: {
        childCount: plannedChildren.length,
        children: siblings,
      },
      compare: ['childCount', 'children'],
    });
  } else if (vocab.has('list_children')) {
    // list_children 只能给 name/id/objType → expect 降级（拿不到 xy/size）
    verify.push({
      op: 'list_children',
      args: { pkg, name: pageName },
      expect: { childCount: plannedChildren.length, names: plannedChildren.map((c) => c.name) },
      compare: ['childCount', 'names'],
    });
    addUnsupported({ tempId: null },
      '词表里没有 read_component，回读降级为 list_children（拿不到 xy/size，只能校验数量与名字）', false);
  } else {
    addUnsupported({ tempId: null },
      '词表里没有任何可用的回读命令（read_component / list_children 都不在）—— 无法回读验证，'
      + '构建结果需人工核对（这是能力缺失，不代表构建失败）', false);
  }

  // ── ⑥ preflight：本地能判的只有这些；运行时事项另列 ──
  const failures = [];
  const readinessStatus = plan.readiness && typeof plan.readiness === 'object'
    ? plan.readiness.status
    : null;
  if (readinessStatus !== 'ready') {
    failures.push({
      code: 'READINESS_NOT_READY',
      detail: readinessStatus
        ? `plan.readiness.status='${readinessStatus}'（要求 'ready'）`
        : 'plan 缺少 readiness.status（要求 \'ready\'）—— 不接受"未评估"的计划直接执行',
    });
  }
  const requiredUnsupported = unsupported.filter((u) => u.required);
  if (requiredUnsupported.length) {
    failures.push({
      code: 'UNSUPPORTED_REQUIRED',
      detail: `${requiredUnsupported.length} 个必需操作无法执行：`
        + requiredUnsupported.map((u) => `${u.source.tempId || '(root)'}: ${u.reason}`).join(' | '),
    });
  }
  if (invalidSteps.length) {
    failures.push({
      code: 'INVALID_STEPS',
      detail: `${invalidSteps.length} 个步骤参数不合规：${invalidSteps.map((s) => s.reason).join(' | ')}`,
    });
  }
  const toImport = (plan.assets && Array.isArray(plan.assets.toImport)) ? plan.assets.toImport : [];
  if (toImport.length) {
    failures.push({
      code: 'RESOURCE_MISSING',
      detail: `${toImport.length} 个素材尚未导入/登记（Bridge 基线没有导入命令，必须人工先在编辑器导入）：`
        + toImport.map((x) => (x && (x.suggestedName || x.name || x.id)) || '(未命名)').join(', '),
    });
  }

  const execPlan = {
    version: EXEC_VERSION,
    target: { pkg, page: pageName, canvas: { w: canvas.w, h: canvas.h } },
    steps,
    invalidSteps,
    unsupported,
    deferred,
    verify: verify.map((v) => ({ ...v, onMismatch: 'fail' })),
    preflight: { ok: failures.length === 0, failures },
    executable: failures.length === 0,
    // ★ 我们**没有**验证过 Bridge 是否在线/编辑器是否打开 —— 这些只能由执行方自查 ★
    runtimeChecks: [
      'Bridge 端口可达（discover_projects / ping 返回 ok）',
      '目标工程已打开（ping.projectOpen === true）',
      '目标包存在且包 id 为 8 位（list_packages）',
      '执行前 close_doc 目标组件（避免内存态覆盖）',
    ],
    summary: {
      steps: steps.length,
      invalidSteps: invalidSteps.length,
      unsupported: unsupported.length,
      unsupportedRequired: requiredUnsupported.length,
      deferred: deferred.reduce((n, x) => n + x.count, 0),
      verify: verify.length,
      preflightFailures: failures.length,
    },
  };
  return { execPlan };
}

module.exports = {
  buildExecPlan,
  BRIDGE_COMMANDS,
  COMMAND_SCHEMA,
  INSERT_CMD_BY_TAG,
  ATTR_MAPPING,
  validateStepArgs,
  EXEC_VERSION,
};
