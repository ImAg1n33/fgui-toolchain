'use strict';
/**
 * src/create/exec-plan.js —— CREATE Executor 地基：`create_plan.json` → **可执行 Bridge 操作清单**
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 为什么先做"清单"而不是直接调 Bridge ★
 *   本机没有 FairyGUI / Unity（PRD K2），Executor 无法本地验证。若直接写成
 *   "只有朋友那台机器能跑"的脚本，我们只能盲写。所以这一步只把 plan 翻译成
 *   **确定性、可人工审阅、可交给朋友执行**的步骤清单（create_exec.json）：
 *     建容器 → 按 layer 升序插节点 → 保存。
 *   本模块**不联网、不调 Bridge、不写任何 FGUI 文件**（纯函数）。
 *
 * ★ 硬约束（违反即 bug）★
 *   1. **命令名只能来自 `BRIDGE_COMMANDS`（= docs/BRIDGE-COMMANDS.md 的词表）**；
 *      词表里没有的 → 进 `unsupported` 并写明原因，**绝不编造命令名**。
 *   2. 顺序确定：容器 → 节点按 `(layer asc, tempId asc)` → `save_all`。
 *      不依赖对象键序、无时间戳、无随机、无绝对路径。
 *   3. 映射不了的字段不静默丢弃：进 step 的 `notes`（或整条进 `unsupported`）。
 * ════════════════════════════════════════════════════════════════════════════
 */

const { AppError, CODES } = require('../core/errors');

/** 产物版本（与 create_plan.version 解耦：执行清单自己的格式版本）。 */
const EXEC_VERSION = '0.1';

/**
 * Bridge 命令词表 —— **以 docs/plugin_main.js.baseline + mcp_server.mjs.baseline 为准**。
 * 详细参数表见 `docs/BRIDGE-COMMANDS.md`。
 *
 * `writes`：是否落盘；`needsEditor`：是否要求编辑器打开（除 discover_projects 外全为 true）。
 */
const BRIDGE_COMMANDS = Object.freeze({
  discover_projects: { writes: false, needsEditor: false, use: '探测在线工程' },
  ping: { writes: false, needsEditor: true, use: '探活' },
  project_info: { writes: false, needsEditor: true, use: '当前工程信息' },
  list_packages: { writes: false, needsEditor: true, use: '包列表' },
  list_items: { writes: false, needsEditor: true, use: '包内资源树' },
  read_component: { writes: false, needsEditor: true, use: '读组件 XML' },
  list_children: { writes: false, needsEditor: true, use: '列舞台子节点' },
  open_doc: { writes: false, needsEditor: true, use: '打开组件文档' },
  close_doc: { writes: false, needsEditor: true, use: '关闭组件文档' },
  bridge_log: { writes: false, needsEditor: true, use: '插件日志' },
  create_package: { writes: true, needsEditor: true, use: '建包' },
  create_component: { writes: true, needsEditor: true, use: '建组件（Page 也是组件）' },
  delete_item: { writes: true, needsEditor: true, use: '删资源项' },
  set_image_scale9: { writes: true, needsEditor: true, use: '库内图片标九宫格' },
  insert_object: { writes: true, needsEditor: true, use: '插入库内已有资源' },
  insert_text: { writes: true, needsEditor: true, use: '插入文本' },
  insert_loader: { writes: true, needsEditor: true, use: '插入装载器' },
  insert_list: { writes: true, needsEditor: true, use: '插入列表' },
  add_controller: { writes: true, needsEditor: true, use: '加控制器' },
  set_gear: { writes: true, needsEditor: true, use: '设置 gear' },
  set_property: { writes: true, needsEditor: true, use: '改舞台子节点属性' },
  remove_object: { writes: true, needsEditor: true, use: '移除舞台子节点' },
  save_all: { writes: true, needsEditor: true, use: '保存所有文档' },
  refresh: { writes: false, needsEditor: true, use: '刷新工程视图' },
  publish: { writes: true, needsEditor: true, use: '发布包（异步）' },
  screenshot: { writes: true, needsEditor: true, use: '截编辑器窗口' },
  // 注意：`write_component` **只在插件层存在、MCP 未暴露**，且 SKILL.md 明令不使用
  //   → 故**不**列入本词表（Executor 不得使用）。
});

/** plan 的 tag → 用于插入它的 Bridge 命令（词表外的 tag → unsupported）。 */
const INSERT_CMD_BY_TAG = Object.freeze({
  image: 'insert_object',
  text: 'insert_text',
  loader: 'insert_loader',
  list: 'insert_list',
});

/**
 * `xy:"x,y"` / `size:"w,h"` → 数值对。
 * @param {string} v
 * @returns {[number,number]|null}
 */
function pair(v) {
  if (typeof v !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * 稳定排序键：先 layer（缺省取 0），再 tempId（字符串序）。**不依赖对象键序**。
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
 * 把 create_plan 翻译成有序执行清单。
 *
 * @param {Object} plan create_plan.json
 * @param {Object} [options]
 * @param {Object} [options.pkgId] 目标包 8 位 id（图片插入必须用它拼 `ui://<pkgId><itemId>`）
 * @param {string[]|Set<string>} [options.vocab] 允许的命令名集合（默认 = BRIDGE_COMMANDS 的键；测试可注入假词表）
 * @returns {{execPlan:Object}} 确定性对象（可直接 JSON.stringify）
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
  const deferred = [];

  /**
   * 追加一步（只允许词表内的命令）。
   * @param {string} op
   * @param {Object} args
   * @param {Object} source
   * @param {string[]} [notes]
   */
  const pushStep = (op, args, source, notes) => {
    if (!vocab.has(op)) {
      // 词表里没有 → 绝不产出（调用方应在此之前拦截；这里是最后一道保险）
      throw new AppError(CODES.INTERNAL, `内部缺陷：试图产出词表外的命令 '${op}'`);
    }
    const step = {
      step: steps.length + 1,
      op,
      args,
      source,
    };
    if (notes && notes.length) step.notes = notes;
    steps.push(step);
  };

  // ── ① 容器：Page 就是一个组件（SKILL.md：create_component 建 Comp，再同样处理 Page）──
  if (vocab.has('create_component')) {
    pushStep('create_component', {
      pkg,
      name: pageName,
      width: canvas.w,
      height: canvas.h,
    }, { tempId: 'P1' }, ['P1 = 页面容器（合成 tempId，对应 plan.page）']);
  } else {
    unsupported.push({
      source: { tempId: 'P1' },
      reason: '词表里没有 create_component —— 无法创建页面容器，后续插入无从谈起',
    });
  }

  // ── ② 节点：按 layer 升序（底→顶）插入 ──
  const nodes = Array.isArray(plan.nodes) ? plan.nodes.slice() : [];
  let indexCursor = 0; // 已计划的兄弟序号 → 作为 index（z 序），跳过 unsupported 时不会错位
  for (const node of nodes.sort(compareNodes)) {
    const tag = node && node.tag ? String(node.tag) : '';
    const tempId = node && node.tempId ? String(node.tempId) : null;
    const cmd = INSERT_CMD_BY_TAG[tag];

    if (!cmd) {
      unsupported.push({
        source: { tempId },
        reason: `Bridge 词表里没有可插入 <${tag || '(无 tag)'}> 的命令`
          + '（基线只提供 insert_object/text/loader/list）—— 待朋友确认',
      });
      continue;
    }
    if (!vocab.has(cmd)) {
      unsupported.push({
        source: { tempId },
        reason: `词表里没有 ${cmd}（本次词表被裁剪或被上游移除），无法插入 <${tag}>`,
      });
      continue;
    }

    const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {};
    const xy = pair(attrs.xy);
    const size = pair(attrs.size);
    const notes = [];

    if (tag === 'image') {
      // insert_object 只接受 url(ui://…) 或 ref_pkg+ref_name（按**资源名**），
      // 而 plan 的 src 是**短资源 ID** → 必须由调用方给出 pkgId 才能拼 url。
      const src = typeof attrs.src === 'string' && attrs.src ? attrs.src : null;
      if (!src) {
        unsupported.push({
          source: { tempId },
          reason: '图片节点没有 src（资源未绑定：多为 toImport / 歧义），无法插入',
        });
        continue;
      }
      if (!pkgId) {
        unsupported.push({
          source: { tempId },
          reason: `图片 src='${src}' 是短资源 ID，而 insert_object 只接受 ui:// url`
            + '（基线里没有"按资源 id 插入"的命令）—— 需要调用方提供包 id（pkgId）才能拼 ui://<pkgId><itemId>',
        });
        continue;
      }
      const args = { pkg, name: pageName, url: `ui://${pkgId}${src}`, index: indexCursor };
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      // insert_object 没有 width/height 参数 → 尺寸走 props（编辑器属性名 size)
      const props = {};
      if (size) props.size = `${size[0]},${size[1]}`;
      if (Object.keys(props).length) args.props = props;
      if (!xy) notes.push('缺少 xy：insert_object 未给坐标，由编辑器默认放置');
      pushStep('insert_object', args, { tempId }, notes.length ? notes : undefined);
      indexCursor += 1;
      continue;
    }

    if (tag === 'text') {
      const args = { pkg, name: pageName, child: node.name || tempId, index: indexCursor };
      if (typeof attrs.text === 'string') args.text = attrs.text;
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      if (size) { args.width = size[0]; args.height = size[1]; }
      if (attrs.color !== undefined) args.color = attrs.color;
      if (attrs.fontSize !== undefined) args.fontSize = Number(attrs.fontSize);
      if (attrs.align !== undefined) args.align = attrs.align;
      if (attrs.vAlign !== undefined) args.vAlign = attrs.vAlign;
      if (attrs.strokeColor !== undefined) args.strokeColor = attrs.strokeColor;
      if (attrs.strokeSize !== undefined) args.strokeSize = Number(attrs.strokeSize);
      // 其余 attrs 没有对应具名参数 → 走 props，绝不静默丢弃
      const rest = {};
      for (const k of Object.keys(attrs)) {
        if (!['xy', 'size', 'text', 'color', 'fontSize', 'align', 'vAlign', 'strokeColor', 'strokeSize'].includes(k)) {
          rest[k] = attrs[k];
        }
      }
      if (Object.keys(rest).length) {
        args.props = rest;
        notes.push(`未具名映射的 attrs 已放进 props：${Object.keys(rest).join(',')}`);
      }
      if (attrs.estimated === true) notes.push('attrs.estimated=true：含估计值，需人工确认');
      pushStep('insert_text', args, { tempId }, notes.length ? notes : undefined);
      indexCursor += 1;
      continue;
    }

    if (tag === 'loader') {
      const args = { pkg, name: pageName, child: node.name || tempId, index: indexCursor };
      if (typeof attrs.url === 'string') args.url = attrs.url;
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      if (size) { args.width = size[0]; args.height = size[1]; }
      pushStep('insert_loader', args, { tempId }, notes.length ? notes : undefined);
      indexCursor += 1;
      continue;
    }

    if (tag === 'list') {
      const args = { pkg, name: pageName, child: node.name || tempId, index: indexCursor };
      if (attrs.defaultItem !== undefined) args.defaultItem = attrs.defaultItem;
      if (attrs.layout !== undefined) args.layout = attrs.layout;
      if (xy) { args.x = xy[0]; args.y = xy[1]; }
      if (size) { args.width = size[0]; args.height = size[1]; }
      pushStep('insert_list', args, { tempId }, notes.length ? notes : undefined);
      indexCursor += 1;
      continue;
    }

    unsupported.push({ source: { tempId }, reason: `未处理的 tag：${tag}` });
  }

  // ── ③ 保存 ──
  if (vocab.has('save_all')) {
    pushStep('save_all', {}, { tempId: null });
  } else {
    unsupported.push({
      source: { tempId: null },
      reason: '词表里没有 save_all —— 所有编辑都不会落盘',
    });
  }

  // ── ④ deferred：v1 明确「只给建议、不自动生成」（不是"缺命令"，但不静默）──
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

  const execPlan = {
    version: EXEC_VERSION,
    target: { pkg, page: pageName, canvas: { w: canvas.w, h: canvas.h } },
    steps,
    unsupported,
    deferred,
    summary: {
      steps: steps.length,
      unsupported: unsupported.length,
      deferred: deferred.reduce((n, x) => n + x.count, 0),
    },
  };
  return { execPlan };
}

module.exports = {
  buildExecPlan,
  BRIDGE_COMMANDS,
  INSERT_CMD_BY_TAG,
  EXEC_VERSION,
};
