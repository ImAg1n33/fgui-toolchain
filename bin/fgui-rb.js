#!/usr/bin/env node
'use strict';
/**
 * bin/fgui-rb.js —— CLI 入口
 *
 * 用法：
 *   node bin/fgui-rb.js <命令> [参数]
 *   node bin/fgui-rb.js --help
 *
 * ★ 环境说明（ARCHITECTURE D1）★
 *   本项目全 CommonJS。`NODE_PATH` 对 ESM 的 import 无效、对 require 有效，
 *   所以请这样跑：
 *     cd /d/UItool && NODE_PATH=".../node_modules" node bin/fgui-rb.js <命令>
 *
 * ★ 离线声明（PRD K1）★
 *   本工具全程本地处理，不发起任何网络请求。
 */

const { main } = require('../src/cli');
const { EXIT } = require('../src/core/errors');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : EXIT.OK;
  })
  .catch((err) => {
    // main 内部已分类处理；走到这里说明是极外层的意外
    process.stderr.write(`未捕获异常: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = EXIT.INTERNAL;
  });
