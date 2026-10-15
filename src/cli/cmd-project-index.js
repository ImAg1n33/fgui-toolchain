'use strict';
/**
 * src/cli/cmd-project-index.js —— M1：FGUI 工程只读索引
 *
 * usage:
 *   fgui-rb project-index --project <工程根 或 .fairy> --out <产物目录>
 *                          [--no-images]  跳过 PNG 特征计算（只建结构索引）
 *
 * 产出（确定性，B9）：
 *   project_index.json   工程里已有什么、什么可复用（M1 的全部价值）
 *
 * ★ 边界（刻意不做，留给 M2）★
 *   · 不与 assets.db 实际关联（只输出关联所需的数据结构 assetLinks）
 *   · 不生成任何 XML、不写目标工程目录（全链路只读）
 *   · 不做 Change Plan 集成
 *
 * ★ 诚实边界 ★
 *   本机无真实 FGUI 工程副本（Q3 未答）：本命令只验证了「按上游 STANDARDS
 *   构造的工程能被正确解析」，未验证真实工程的形态多样性。
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('../core/fs-json');
const { toPosixRel } = require('../core/determinism');
const { AppError, CODES, EXIT } = require('../core/errors');
const { locateProject, discoverPackages } = require('../fgui/project-reader');
const { indexPackage } = require('../fgui/package-indexer');
const { indexComponentXml } = require('../fgui/component-indexer');
const { parseUiRef } = require('../fgui/resource-resolver');
const { flagBool } = require('./args');
const { createDecoder } = require('../imaging/decoder');
const { computeAlphaStats } = require('../imaging/features');
const { phashFromRgba } = require('../imaging/phash');

/** 索引产物版本。 */
const INDEX_VERSION = '1.0';

/**
 * 列出包目录下的组件 XML（排除 package.xml 本身，按名排序保证确定性）。
 * @param {string} pkgDir 包目录绝对路径
 * @returns {string[]} 组件 XML 文件名
 */
function listComponentXmlFiles(pkgDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(pkgDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => /\.xml$/i.test(e) && e.toLowerCase() !== 'package.xml')
    .sort();
}

/**
 * 计算一张图片的关联字段（尺寸 / alpha 覆盖 / pHash）。失败记 null + warning，
 * 不让单张坏图打断索引。
 *
 * @param {string} absPath 图片绝对路径
 * @returns {Promise<{width:number, height:number, alphaRatio:number, phash:string}|null>}
 */
async function imageStats(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const decoder = createDecoder({});
    const img = await decoder.decodeToRgba(buf);
    if (!img || !img.width || !img.height) return null;
    const alpha = computeAlphaStats(img);
    return {
      width: img.width,
      height: img.height,
      alphaRatio: alpha ? alpha.alphaRatio : null,
      phash: phashFromRgba(img),
    };
  } catch {
    return null;
  }
}

/**
 * 执行工程索引。
 * @param {Object} ctx
 * @returns {Promise<number>} 退出码
 */
async function run(ctx) {
  const { flags, logger, rootDir } = ctx;
  const outDir = path.resolve(rootDir, flags.out ? String(flags.out) : 'out');
  const projectInput = flags.project ? String(flags.project) : null;
  if (!projectInput) {
    throw new AppError(CODES.USAGE,
      '需要 --project <工程根目录 或 .fairy 文件>\n'
      + '提示：project-index 是只读索引，不会改动目标工程任何文件');
  }
  const withImages = flagBool(flags.images, true);

  // ---- 1. 定位工程与包（只读）----
  const located = locateProject(projectInput);
  const root = located.root;
  const warnings = [];
  if (located.warning) warnings.push(located.warning);
  const discovered = discoverPackages(root);
  warnings.push(...discovered.warnings);
  logger.info('发现 FGUI 工程', {
    root: toPosixRel(rootDir, root),
    fairy: located.fairyFile,
    packages: discovered.packages.map((p) => p.name),
  });

  // ---- 2. 资源层（package.xml）+ 组件层（组件 XML）----
  /** @type {Object[]} */
  const packages = [];
  /** @type {Object[]} */
  const resources = [];
  /** @type {Object[]} */
  const components = [];
  /** @type {Object[]} */
  const uiRefs = [];

  for (const pkg of discovered.packages) {
    const pkgXmlPath = path.join(pkg.dir, 'package.xml');
    const indexed = indexPackage(pkgXmlPath);
    // 包 id 的持久化位置：package.xml 的 packageDescription 若带 id 属性则取，
    // 否则记 null + warning（真实持久化位置待真实工程确认，见 IMPLEMENTATION-REPORT M1）
    const pkgId = indexed.ok && indexed.packageId ? indexed.packageId : null;
    if (!pkgId) {
      warnings.push(`包『${pkg.name}』未在 package.xml 找到 8 位包 id —— `
        + 'ui:// 引用将只能按包名匹配（包 id 持久化位置待真实工程确认）');
    }

    const compFiles = listComponentXmlFiles(pkg.dir);
    packages.push({
      name: pkg.name,
      id: pkgId,
      relPath: pkg.dir, // PATH_KEYS：writeJson 会自动相对化
      file: pkgXmlPath,
      resourceCount: indexed.resources.length,
      componentCount: compFiles.length,
      parseError: indexed.error,
    });

    for (const r of indexed.resources) {
      const entry = {
        pkg: pkg.name,
        pkgId,
        type: r.type,
        id: r.id,
        name: r.name,
        folder: r.path, // 包内目录属性（不是文件系统路径，故不用 path 键）
        exported: r.exported,
        scale: r.scale,
        scale9grid: r.scale9grid,
        width: r.width,
        height: r.height,
        file: null,
        image: null,
      };
      // 图片文件定位：package.xml 的 path 属性是**包内目录**（如 '/' 或 '/images/'）。
      // 真实工程里它与文件实际位置未必严格对应，故按多个候选位置宽容查找。
      if (r.type === 'image' && r.name) {
        const folder = (r.path || '').replace(/^\/+|\/+$/g, '');
        const candidates = [
          path.join(pkg.dir, folder, r.name), // 包内子目录（path 属性的字面语义）
          path.join(pkg.dir, r.name), // 包根（path 属性与实际位置不符时）
        ].filter((p, i, arr) => arr.indexOf(p) === i);
        const abs = candidates.find((p) => fs.existsSync(p)) || null;
        if (abs) {
          entry.file = abs;
          if (withImages) {
            const stats = await imageStats(abs);
            if (stats) {
              entry.image = stats;
              if (entry.width === null) entry.width = stats.width;
              if (entry.height === null) entry.height = stats.height;
            } else {
              warnings.push(`图片特征计算失败（${r.name} @ ${pkg.name}）—— image 字段记 null`);
            }
          }
        } else {
          warnings.push(`图片文件未找到（${folder ? `${folder}/` : ''}${r.name} @ ${pkg.name}）—— `
            + '可能被移动/改名，或 path 属性不是目录语义');
        }
      }
      resources.push(entry);
    }

    // package.xml 登记的组件 id（name -> id），供引用图按 itemId 命中组件
    const compIdByName = new Map();
    for (const r of indexed.resources) {
      if (r.type === 'component' && r.name && r.id) compIdByName.set(r.name, r.id);
    }

    for (const f of compFiles) {
      const abs = path.join(pkg.dir, f);
      let text = '';
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        warnings.push(`组件读取失败（${f} @ ${pkg.name}）：${err.message}`);
        continue;
      }
      const indexed2 = indexComponentXml(text);
      const name = basenameOfXml(f);
      components.push({
        pkg: pkg.name,
        name: indexed2.ok ? (componentName(indexed2) || name) : name,
        resourceId: compIdByName.get(name) || null,
        file: abs,
        size: indexed2.size,
        extention: indexed2.extention,
        exported: indexed2.exported,
        nodeCount: countNodes(indexed2.root),
        uiRefCount: indexed2.uiRefs.length,
        parseError: indexed2.error,
        warnings: indexed2.warnings,
      });
      for (const u of indexed2.uiRefs) {
        uiRefs.push({
          from: `${pkg.name}/${f}`,
          node: u.path,
          attr: u.attr,
          raw: u.ref.raw,
          style: u.ref.style,
          pkgId: u.ref.pkgId,
          itemId: u.ref.itemId,
        });
      }
    }
  }

  // ---- 3. 引用图 + 可复用查询结构（M1 存在的理由）----
  const refGraph = buildRefGraph({ packages, resources, components, uiRefs });

  // ---- 4. 组装产物 ----
  const plan = {
    version: INDEX_VERSION,
    _comment: '由 fgui-rb project-index 生成（M1：FGUI 工程只读索引）。'
      + '回答「工程里已有什么、什么可复用」；不与 assets.db 实际关联（M2 的事）。'
      + '本文件可手工编辑，确定性输出（无时间戳、路径相对化、键序固定）。',
    _fieldNote: {
      project: '工程层：包列表（name / id / relPath / 资源与组件计数）',
      resources: '资源层（package.xml 登记）：image/component 等；image 字段是'
        + '与 assets.db 关联所需的特征（尺寸/alpha 覆盖/pHash），--no-images 时为 null',
      components: '组件层：组件名 / 尺寸 / extention / 节点数 / ui:// 引用数',
      referenceGraph: '引用图：ui:// 谁引用哪个包的哪个资源；按资源与按组件两个维度',
      reuse: '可复用查询结构：组件被引用次数、图片被引用次数、按名/按尺寸索引',
      assetLinks: '与 assets.db 关联的数据结构（只留数据，不实际关联 —— M2）',
    },
    project: {
      name: located.fairyFile ? basenameOfFairy(located.fairyFile) : basenameByShape(root),
      fairyFile: located.fairyFile,
      relPath: root,
      packages,
    },
    resources,
    components,
    referenceGraph: refGraph.referenceGraph,
    reuse: refGraph.reuse,
    assetLinks: resources
      .filter((r) => r.image)
      .map((r) => ({
        pkg: r.pkg,
        name: r.name,
        resourceId: r.id,
        width: r.image.width,
        height: r.image.height,
        alphaRatio: r.image.alphaRatio,
        phash: r.image.phash,
      })),
    warnings,
  };

  const outPath = path.join(outDir, 'project_index.json');
  writeJson(outPath, plan, { root: rootDir });
  // ★ 展示路径用宿主 relative（与其余 CLI 一致）：out 可能在工程根之外（跨盘），
  //   此时 toPosixRel 会按 B9 规则明确报错 —— 展示层不该触发它
  logger.info('索引已写出', { file: path.relative(outDir, outPath).replace(/\\/g, '/'), packages: packages.length, resources: resources.length, components: components.length });

  process.stdout.write(JSON.stringify({
    command: 'project-index',
    ok: true,
    outputs: { projectIndex: path.relative(outDir, outPath).replace(/\\/g, '/') },
    summary: {
      packages: packages.length,
      resources: resources.length,
      components: components.length,
      uiRefs: uiRefs.length,
      warnings: warnings.length,
    },
    warningCount: warnings.length,
  }, null, 2) + '\n');
  return EXIT.OK;
}

/** 组件名：根组件无 name 属性时用文件名。 */
function componentName(indexed) {
  return indexed.root && indexed.root.name ? indexed.root.name : null;
}

/** 去掉 .xml 后缀（大小写不敏感）。 */
function basenameOfXml(f) {
  return String(f).replace(/\.xml$/i, '');
}

/** 去掉 .fairy 后缀。 */
function basenameOfFairy(f) {
  return String(f).replace(/\.fairy$/i, '');
}

/** 递归数节点数。 */
function countNodes(node) {
  if (!node) return 0;
  let n = 1;
  for (const c of node.children || []) n += countNodes(c);
  return n;
}

/**
 * 构建引用图与可复用查询结构。
 *
 * 引用解析（两种 ui:// 风格都支持）：
 *   1. pkgId 命中已知包 id -> 精确定位到包 + itemId；
 *   2. pkgId 未命中 -> 尝试把 pkgId 当包名（宽容：真实工程里 ui:// 用的是 id，
 *      但手写/遗留 XML 可能出现包名），命中则定位并记 warning 说明降级匹配；
 *   3. 都不命中 -> unresolved（记 warning，这是「真实工程副本到手后最可能
 *      暴露的解析缺口」之一）。
 *
 * @returns {{referenceGraph:Object, reuse:Object}}
 */
function buildRefGraph({ packages, resources, components, uiRefs }) {
  const byPkgId = new Map();
  const byPkgName = new Map();
  for (const p of packages) {
    if (p.id) byPkgId.set(p.id, p);
    byPkgName.set(p.name, p);
  }
  const resourceByPkgItem = new Map(); // `${pkgName}:${itemId}` -> resource entry
  const resourceByPkgName = new Map(); // `${pkgName}:${name}` -> resource entry
  for (const r of resources) {
    if (r.id) resourceByPkgItem.set(`${r.pkg}:${r.id}`, r);
    if (r.name) resourceByPkgName.set(`${r.pkg}:${r.name}`, r);
  }
  const componentByPkgItem = new Map();
  const componentByPkgName = new Map();
  for (const c of components) {
    if (c.name) componentByPkgName.set(`${c.pkg}:${c.name}`, c);
    if (c.resourceId) componentByPkgItem.set(`${c.pkg}:${c.resourceId}`, c);
  }

  const edges = [];
  const unresolved = [];
  const compRefCounts = new Map(); // `${pkg}/${name}` -> 被引用次数
  const imgRefCounts = new Map(); // `${pkg}/${id or name}` -> 被引用次数

  for (const u of uiRefs) {
    let targetPkg = byPkgId.get(u.pkgId) || null;
    let matchedBy = 'pkgId';
    if (!targetPkg && byPkgName.has(u.pkgId)) {
      targetPkg = byPkgName.get(u.pkgId);
      matchedBy = 'pkgName';
      unresolved.push({ ...u, reason: 'pkgId 未命中，已按包名降级匹配（请人工确认）' });
    }
    if (!targetPkg) {
      unresolved.push({ ...u, reason: 'pkgId 在工程内未找到对应包' });
      continue;
    }
    // itemId 优先按资源 id 命中，其次按资源名（遗留/手写 XML 常用名）
    let target = resourceByPkgItem.get(`${targetPkg.name}:${u.itemId}`) || null;
    let itemMatchedBy = 'itemId';
    if (!target) {
      target = resourceByPkgName.get(`${targetPkg.name}:${u.itemId}`) || null;
      if (target) itemMatchedBy = 'name';
    }
    if (!target) {
      const comp = componentByPkgName.get(`${targetPkg.name}:${u.itemId}`)
        || (componentByPkgItem.get(`${targetPkg.name}:${u.itemId}`) || null);
      if (comp) {
        target = { ...comp, type: 'component', _isComponent: true };
        itemMatchedBy = 'componentName';
      }
    }
    if (!target) {
      unresolved.push({ ...u, reason: `包『${targetPkg.name}』内未找到 itemId/name='${u.itemId}' 的已登记资源` });
      continue;
    }
    edges.push({
      from: u.from,
      node: u.node,
      attr: u.attr,
      raw: u.raw,
      style: u.style,
      to: { pkg: targetPkg.name, type: target.type || 'component', id: target.id || null, name: target.name || null },
      matchedBy: `${matchedBy}+${itemMatchedBy}`,
    });
    if ((target.type || 'component') === 'component' || target._isComponent) {
      const k = `${targetPkg.name}/${target.name || u.itemId}`;
      compRefCounts.set(k, (compRefCounts.get(k) || 0) + 1);
    } else {
      const k = `${targetPkg.name}/${target.id || target.name || u.itemId}`;
      imgRefCounts.set(k, (imgRefCounts.get(k) || 0) + 1);
    }
  }

  // 按名 / 按尺寸查询结构
  const componentsByName = {};
  for (const c of components) {
    const k = c.name || '(unnamed)';
    if (!componentsByName[k]) componentsByName[k] = [];
    componentsByName[k].push(`${c.pkg}/${c.name}`);
  }
  const componentsBySize = {};
  for (const c of components) {
    if (!c.size) continue;
    const k = `${c.size[0]}x${c.size[1]}`;
    if (!componentsBySize[k]) componentsBySize[k] = [];
    componentsBySize[k].push(`${c.pkg}/${c.name}`);
  }

  return {
    referenceGraph: {
      edges,
      unresolved,
      edgeCount: edges.length,
      unresolvedCount: unresolved.length,
    },
    reuse: {
      componentRefCounts: toSortedObject(compRefCounts),
      imageRefCounts: toSortedObject(imgRefCounts),
      componentsByName,
      componentsBySize,
      _note: 'componentRefCounts/imageRefCounts = 被引用次数（0 = 没人用，可考虑复用或清理）；'
        + '按名/按尺寸查询用于「工程里有没有现成能用的件」',
    },
  };
}

/**
 * Map -> 键排序的普通对象（确定性输出）。
 * @param {Map<string,number>} m
 * @returns {Object}
 */
function toSortedObject(m) {
  const out = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k);
  return out;
}

module.exports = { run };
