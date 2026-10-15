'use strict';
/**
 * src/fgui/package-indexer.js —— M1 第 2 个模块：解析 package.xml
 *
 * package.xml 结构（上游事实：packageDescription/resources 下按类型登记；
 * bridge 的 set_image_scale9 等命令直接读写 image 标签的 id/scale/scale9grid）：
 *
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <packageDescription version="1.0">
 *     <resources>
 *       <image id="a1b2c3d4" name="popup_bg.png" path="/Common/" exported="true"
 *              scale="9grid" scale9grid="10,10,444,284"/>
 *       <component id="e5f6a7b8" name="MailDetail" path="/Mail/" exported="true"/>
 *       <movieclip id="f1a2b3c4" name="fx" path="/Common/"/>
 *     </resources>
 *   </packageDescription>
 *
 * ★ 宽容解析 ★
 *   indexer 的职责是**提取信息**，不是判死刑：字段缺失记 null + warning；
 *   整个文件解析失败只让该包降级（package 条目带 parseError），不影响其他包。
 */

const { parseXmlDocument } = require('./xml-parse');

/** package.xml 里出现的资源标签类型（image/component 之外也登记，如实记录）。 */
const RESOURCE_TAGS = Object.freeze(['image', 'component', 'movieclip', 'font', 'sound']);

/**
 * 解析一个包的 package.xml。
 *
 * @param {string} packageXmlPath package.xml 绝对路径
 * @returns {{ok:boolean, error:string|null, packageId:string|null, version:string|null,
 *            resources:Object[], rootAttrs:Object, warnings:string[]}}
 */
function indexPackage(packageXmlPath) {
  const out = {
    ok: false,
    error: null,
    packageId: null,
    version: null,
    resources: [],
    rootAttrs: {},
    warnings: [],
  };

  let src = '';
  try {
    // eslint-disable-next-line global-require
    src = require('fs').readFileSync(packageXmlPath, 'utf8');
  } catch (err) {
    out.error = `读取失败: ${err.message}`;
    out.warnings.push(`package.xml 读取失败（${packageXmlPath}）—— 该包跳过资源层索引`);
    return out;
  }

  let parsed;
  try {
    parsed = parseXmlDocument(src);
  } catch (err) {
    out.error = `解析器异常: ${err.message}`;
    out.warnings.push(`package.xml 解析异常（${packageXmlPath}）—— 该包跳过资源层索引`);
    return out;
  }

  const root = parsed.root;
  if (!root || root.tag !== 'packageDescription') {
    out.error = `根元素不是 <packageDescription>（实际: ${root ? root.tag : 'null'}）`;
    out.warnings.push(`package.xml 结构不符（${packageXmlPath}）—— 该包跳过资源层索引`);
    return out;
  }
  out.ok = true;
  out.rootAttrs = { ...root.attrs };
  out.version = root.attrs.version === undefined ? null : String(root.attrs.version);
  // 包 id 的持久化位置在真实工程里未确认（Q3 未答）：若 packageDescription 带 id
  // 属性就取，否则记 null 由上层 warning —— 绝不猜。
  out.packageId = root.attrs.id === undefined ? null : String(root.attrs.id);

  // 资源节点：兼容 <resources> 包裹与直接挂根下两种形态
  const containers = root.children.filter((c) => c.tag === 'resources');
  const scope = containers.length ? containers : [root];
  const seen = new Set();
  for (const box of scope) {
    for (const node of box.children) {
      if (!RESOURCE_TAGS.includes(node.tag)) continue;
      const key = `${node.tag}:${node.attrs.id || node.attrs.name || ''}`;
      if (seen.has(key)) continue; // 重复登记只记一次（确定性）
      seen.add(key);
      const exported = node.attrs.exported;
      out.resources.push({
        type: node.tag,
        id: node.attrs.id === undefined ? null : String(node.attrs.id),
        name: node.attrs.name === undefined ? null : String(node.attrs.name),
        path: node.attrs.path === undefined ? null : String(node.attrs.path),
        exported: exported === undefined ? null : String(exported),
        scale: node.attrs.scale === undefined ? null : String(node.attrs.scale),
        scale9grid: node.attrs.scale9grid === undefined ? null : String(node.attrs.scale9grid),
        width: toNum(node.attrs.width),
        height: toNum(node.attrs.height),
      });
    }
  }
  if (!out.resources.length) {
    out.warnings.push(`package.xml 内未发现资源登记（${packageXmlPath}）`);
  }
  return out;
}

/**
 * 数字属性转 number，非数字/缺失返 null（宽容，不抛）。
 * @param {string|undefined} v
 * @returns {number|null}
 */
function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  indexPackage,
  RESOURCE_TAGS,
};
