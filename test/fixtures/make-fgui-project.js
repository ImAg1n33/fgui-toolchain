'use strict';
/**
 * test/fixtures/make-fgui-project.js —— 合成 FGUI 工程 fixture（M1 用）
 *
 * ★ 为什么自己造：本机没有真实 FGUI 工程副本（Q3 未答），而 indexer 必须被
 *   真实形态的数据验证 —— 按上游 STANDARDS（UPSTREAM-README + plugin baseline
 *   的消费方式）逐条构造，是我们唯一能拿到的「独立于实现」的验证数据。
 *   ⚠ 边界：这验证的是「按规范构造的工程能被正确解析」，**不是**真实工程的
 *   形态多样性（见 IMPLEMENTATION-REPORT M1 章节的诚实声明）。
 *
 * 结构（两个包 + 3 个组件 + ui:// 两种风格 + 九宫格图 + 2x 图）：
 *
 *   fgui-project/
 *     MailPopup.fairy
 *     assets/
 *       Common/          包 id 固定 8 位（a1b2c3d4）
 *         package.xml    image ×3（popup_bg 九宫格 / btn_close 2x / deco_line）
 *                        component ×1（PopupFrame）
 *         PopupFrame.xml 页面复用件：引用 Common 自己的图 + MailDetail 的组件
 *         popup_bg.png / btn_close.png / deco_line.png
 *       MailDetail/      包 id e5f6a7b8
 *         package.xml    image ×1（reward_icon）+ component ×2（MailDetail / RewardCell）
 *         MailDetail.xml 页面组件：图 + 嵌套 component（ui:// 斜杠风格）
 *         RewardCell.xml cell：图 + 嵌套 component（ui:// 拼接风格，上游 bridge 风格）
 *         reward_icon.png
 *
 * ★ 确定性（B9）★：两次生成逐字节一致（无时间戳、排序稳定、PNG 确定性编码）。
 */

const fs = require('fs');
const path = require('path');
const {
  installCanvasShim, createImageData, composeImageData,
} = require('../../src/psd/canvas-shim');

/** 输出目录（相对项目根）。 */
const OUT_DIR = path.resolve(__dirname, 'fgui-project');

/** 两个包的 id（8 位，与 constants.PKG_ID_LENGTH 对齐）。 */
const PKG = Object.freeze({
  Common: { id: 'a1b2c3d4', dir: 'Common' },
  MailDetail: { id: 'e5f6a7b8', dir: 'MailDetail' },
});

/**
 * 造一张纯色 PNG（确定性：同参数同字节）。
 * @param {number} w
 * @param {number} h
 * @param {[number,number,number,number]} rgba
 * @param {string} name
 * @returns {Object} ag-psd 风格的 imageData（canvas-shim 认识）
 */
function solidPng(w, h, rgba, name) {
  installCanvasShim({ force: true });
  const img = createImageData(w, h);
  const [r, g, b, a] = rgba;
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  img.name = name;
  return img;
}

/**
 * 写一个 PNG 文件（pngjs 确定性编码）。
 * @param {string} absPath
 * @param {Object} img {width,height,data}
 */
function writePng(absPath, img) {
  // eslint-disable-next-line global-require
  const { PNG } = require('pngjs');
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  fs.writeFileSync(absPath, PNG.sync.write(png));
}

/**
 * 构造合成工程（确定性）。
 * @param {Object} [opts]
 * @param {string} [opts.outDir]
 * @returns {{outDir:string, files:string[]}}
 */
function makeFguiProject(opts = {}) {
  const outDir = opts.outDir || OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];

  const write = (rel, content) => {
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    files.push(rel);
  };

  // ---- 工程标记 ----
  write('MailPopup.fairy', 'MailPopup\n');

  // ---- 图片资源（Common 包）----
  const commonDir = path.join(outDir, 'assets', PKG.Common.dir);
  const mailDir = path.join(outDir, 'assets', PKG.MailDetail.dir);
  fs.mkdirSync(commonDir, { recursive: true });
  fs.mkdirSync(mailDir, { recursive: true });

  writePng(path.join(commonDir, 'popup_bg.png'), solidPng(480, 320, [46, 58, 82, 255], 'popup_bg'));
  writePng(path.join(commonDir, 'btn_close.png'), solidPng(64, 64, [200, 90, 90, 255], 'btn_close'));
  writePng(path.join(commonDir, 'deco_line.png'), solidPng(240, 4, [120, 150, 200, 255], 'deco_line'));
  writePng(path.join(mailDir, 'reward_icon.png'), solidPng(96, 96, [232, 180, 96, 255], 'reward_icon'));
  files.push('assets/Common/popup_bg.png', 'assets/Common/btn_close.png',
    'assets/Common/deco_line.png', 'assets/MailDetail/reward_icon.png');

  // ---- Common/package.xml（popup_bg 带九宫格；组件 PopupFrame）----
  write('assets/Common/package.xml', [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<packageDescription version="1.0" id="${PKG.Common.id}">`,
    '  <resources>',
    '    <image id="b1c2d3e4" name="popup_bg.png" path="/Common/" exported="true" scale="9grid" scale9grid="24,24,432,272"/>',
    '    <image id="c2d3e4f5" name="btn_close.png" path="/Common/" exported="true"/>',
    '    <image id="d3e4f5a6" name="deco_line.png" path="/Common/" exported="true"/>',
    `    <component id="e4f5a6b7" name="PopupFrame" path="/Common/" exported="true"/>`,
    '  </resources>',
    '</packageDescription>',
    '',
  ].join('\n'));

  // ---- Common/PopupFrame.xml（复用件：引用本包图 + 跨包组件）----
  write('assets/Common/PopupFrame.xml', [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="480,320" exported="true">',
    '  <displayList>',
    `    <image id="b00001" name="popup_bg" src="ui://${PKG.Common.id}/b1c2d3e4" xy="0,0" size="480,320"/>`,
    `    <image id="b00002" name="deco_line" src="ui://${PKG.Common.id}/d3e4f5a6" xy="24,20" size="240,4"/>`,
    `    <loader id="b00003" name="btn_close" url="ui://${PKG.Common.id}/c2d3e4f5" xy="416,16" size="64,64"/>`,
    `    <component id="c00001" name="mail_content" src="ui://${PKG.MailDetail.id}/f6a7b8c9" xy="0,0" size="480,320"/>`,
    '  </displayList>',
    '</component>',
    '',
  ].join('\n'));

  // ---- MailDetail/package.xml ----
  write('assets/MailDetail/package.xml', [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<packageDescription version="1.0" id="${PKG.MailDetail.id}">`,
    '  <resources>',
    '    <image id="a7b8c9d0" name="reward_icon.png" path="/MailDetail/" exported="true"/>',
    `    <component id="f6a7b8c9" name="MailDetail" path="/MailDetail/" exported="true"/>`,
    `    <component id="b8c9d0e1" name="RewardCell" path="/MailDetail/" exported="true"/>`,
    '  </resources>',
    '</packageDescription>',
    '',
  ].join('\n'));

  // ---- MailDetail/MailDetail.xml（页面：图 + 嵌套组件 + 列表 cell）----
  write('assets/MailDetail/MailDetail.xml', [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="560,360" extention="Button" exported="true">',
    '  <displayList>',
    `    <component id="c00001" name="frame" src="ui://${PKG.Common.id}/e4f5a6b7" xy="0,0" size="480,320"/>`,
    `    <image id="b00001" name="reward_icon" src="ui://${PKG.MailDetail.id}/a7b8c9d0" xy="24,24" size="96,96"/>`,
    `    <text id="b00002" name="title" xy="140,32" size="200,36" text="邮件详情"/>`,
    `    <list id="b00003" name="rewards" xy="24,140" size="312,96" defaultItem="RewardCell"/>`,
    '  </displayList>',
    '</component>',
    '',
  ].join('\n'));

  // ---- MailDetail/RewardCell.xml（cell；**ui:// 拼接风格**，上游 bridge 风格）----
  write('assets/MailDetail/RewardCell.xml', [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="96,96" exported="true">',
    '  <displayList>',
    // 注意：无斜杠拼接（itemUrl = 'ui://' + pkgId + itemId），这是上游编辑器的真实风格
    `    <image id="b00001" name="icon" src="ui://${PKG.MailDetail.id}a7b8c9d0" xy="0,0" size="96,96"/>`,
    `    <graph id="b00002" name="bg" xy="0,0" size="96,96"/>`,
    '  </displayList>',
    '</component>',
    '',
  ].join('\n'));

  files.sort();
  return { outDir, files };
}

module.exports = {
  makeFguiProject,
  PKG,
  OUT_DIR,
  writePng,
  solidPng,
};

// 直接执行时生成（npm run fgui-fixtures）
if (require.main === module) {
  const res = makeFguiProject();
  process.stdout.write(`make-fgui-project: 生成合成 FGUI 工程 -> ${res.outDir}（${res.files.length} 个文件）\n`);
}
