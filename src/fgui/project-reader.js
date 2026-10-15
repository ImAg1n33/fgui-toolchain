'use strict';
/**
 * src/fgui/project-reader.js —— M1 第 1 个模块：读 .fairy 工程、发现包结构
 *
 * FGUI 工程结构（上游事实：UI 工程根含 .fairy 文件，包在 assets/<包名>/ 下，
 * 每个包一个 package.xml；组件 XML 与图片同目录或子目录）。
 *
 *   <projectRoot>/
 *     <Name>.fairy           工程标记文件（文本，含工程名等）
 *     assets/
 *       Common/package.xml + *.xml + *.png
 *       MailDetail/package.xml + *.xml + *.png
 *
 * ★ 只读铁律 ★
 *   本模块（以及 M1 其余模块）**绝不写目标工程目录** —— 只做 fs.stat /
 *   readFileSync / readdirSync。验收方式：运行前后对工程目录做文件级快照
 *   （含 mtime）对比，零变化（见 test/unit/project-index.test.js）。
 *
 * ★ 确定性 ★
 *   所有输出路径经 toPosixRel 相对化；目录遍历结果显式排序。
 */

const fs = require('fs');
const path = require('path');
const { AppError, CODES } = require('../core/errors');
const { toPosixRel, basenameByShape } = require('../core/determinism');

/** 包内登记的 XML 文件扩展名。 */
const PACKAGE_XML = 'package.xml';

/**
 * 判断路径是否为 .fairy 工程文件（大小写不敏感）。
 * @param {string} p
 * @returns {boolean}
 */
function isFairyFile(p) {
  return typeof p === 'string' && /\.fairy$/i.test(p.trim());
}

/**
 * 定位工程根目录。
 *
 * 接受三种输入（与上游 CLI 的 project 参数口径一致：目录 / .fairy 文件）：
 *   1. `<root>/<Name>.fairy` 文件 -> 取其所在目录
 *   2. 含 .fairy 文件的目录      -> 直接用
 *   3. 不含 .fairy 的目录        -> 宽容接受（记 warning），编辑器未保存标记时也能索引
 *
 * @param {string} projectInput 工程根目录或 .fairy 文件路径
 * @returns {{root:string, fairyFile:string|null, warning:string|null}}
 */
function locateProject(projectInput) {
  if (typeof projectInput !== 'string' || !projectInput.trim()) {
    throw new AppError(CODES.USAGE, '需要 --project <工程根目录 或 .fairy 文件>');
  }
  const abs = path.resolve(projectInput);

  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new AppError(CODES.FILE_NOT_FOUND, `工程路径不存在: ${abs}`, { project: abs });
  }

  if (stat.isFile()) {
    if (!isFairyFile(abs)) {
      throw new AppError(CODES.USAGE,
        `--project 指向文件但不是 .fairy 工程文件: ${abs}`);
    }
    return { root: path.dirname(abs), fairyFile: basenameByShape(abs), warning: null };
  }

  // 目录：找 .fairy（确定性：排序后取第一个）
  let entries = [];
  try {
    entries = fs.readdirSync(abs).sort();
  } catch (err) {
    throw new AppError(CODES.READ_FAILED, `读取工程目录失败: ${abs}`, { cause: err.message });
  }
  const fairy = entries.find((e) => isFairyFile(e));
  if (fairy) {
    return { root: abs, fairyFile: fairy, warning: null };
  }
  return {
    root: abs,
    fairyFile: null,
    warning: `目录内未找到 .fairy 工程标记文件（${basenameByShape(abs)}）—— `
      + '仍按目录结构索引，但请确认这是 FGUI 工程根',
  };
}

/**
 * 发现工程内的包（含 package.xml 的目录）。
 *
 * 扫描范围：`<root>/assets/<包名>/package.xml`（上游标准布局），并宽容地再扫一层
 * `<root>/<包名>/package.xml`（部分工程把包放根下）。结果按目录名排序（确定性）。
 *
 * @param {string} root 工程根目录（绝对路径）
 * @returns {{packages:{dir:string, name:string}[], warnings:string[]}}
 */
function discoverPackages(root) {
  const warnings = [];
  const found = new Map(); // dir -> name（去重）
  const scan = (base) => {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return; // assets/ 不存在等情况：宽容跳过
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      if (fs.existsSync(path.join(dir, PACKAGE_XML))) {
        found.set(dir, e.name);
      }
    }
  };

  const assets = path.join(root, 'assets');
  if (fs.existsSync(assets)) {
    scan(assets);
  } else {
    warnings.push(`工程内未找到 assets/ 目录（${toPosixRel(root, assets)}）—— `
      + '已退化为扫描根目录下一层');
  }
  // 兼容布局：包直接放工程根下
  scan(root);

  const packages = [...found.entries()]
    .map(([dir, name]) => ({ dir, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!packages.length) {
    warnings.push('未发现任何包含 package.xml 的包目录 —— 若这是真实工程，请检查目录结构');
  }
  return { packages, warnings };
}

module.exports = {
  locateProject,
  discoverPackages,
  isFairyFile,
  PACKAGE_XML,
};
