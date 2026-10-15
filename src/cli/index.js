'use strict';
/**
 * src/cli/index.js —— 命令注册表 + 参数解析
 *
 * 设计约束（ARCHITECTURE §8.2）：
 *   · **日志走 stderr，产物数据走 stdout** ——
 *     这样 `fgui-rb asset-index ... > report.json` 能直接拿到干净 JSON
 *   · 所有命令都是纯本地的，**不发起任何网络请求**（PRD K1）
 *
 * 参数风格：`--key value` 或 `--key=value`，布尔用 `--flag` / `--no-flag`。
 *
 * ★ 参数命名约定（避免同名歧义）★
 *   --root    项目根目录（用于定位 fgui.config.json）
 *   --assets  切图素材目录
 *   --out     产物输出目录
 *   ★ 这三个曾因 `--root` 一名两用而串味（切图目录被拼成
 *     `<assets>/<assets>`），故严格分开，改动时务必留意。
 */

const path = require('path');
const { loadConfig } = require('../core/config');
const { createLogger } = require('../core/logger');
const { AppError, EXIT, toAppError } = require('../core/errors');

/** 命令表。 */
const COMMANDS = Object.freeze({
  'asset-index': { module: './cmd-asset-index', desc: 'R1-F1 建索引：递归扫描切图目录 -> assets.db + map.json + contact_sheet.html' },
  'asset-search': { module: './cmd-asset-search', desc: 'R1-F5 检索 + 人工确认写 map.json' },
  'psd-ir': { module: './cmd-psd-ir', desc: 'R2-F4 解析 PSD -> design_ir.json + ir_overlay.html' },
  'diff-plan': { module: './cmd-diff-plan', desc: 'R3 差异分析 -> change_plan.json' },
  'calibrate-grid9': { module: './cmd-calibrate-grid9', desc: 'E-03 九宫格阈值标定：切图目录 + 人工标注 -> 建议阈值 + 差异报告（只建议，不改配置）' },
  selftest: { module: './cmd-selftest', desc: '一键自检（合成黄金样本跑通全链路）' },
  'gen-xml': { module: './cmd-gen-xml', desc: '[P1 桩] 生成 FGUI 组件 XML —— 本轮未实现' },
  'project-index': { module: './cmd-project-index', desc: 'M1：FGUI 工程只读索引（package.xml + 组件 XML -> project_index.json）' },
});

/**
 * 解析 argv。
 *
 * ★ 重复传入的 flag 会聚合成数组 ★（如 `--psd a.psd --psd b.psd`，
 *   用于 R2-F7 多份 PSD 一次解析）。调用方需同时兼容 string 与 string[]。
 *
 * @param {string[]} argv 不含 node 与脚本路径
 * @returns {{cmd:string, flags:Object, positional:string[], raw:string[]}}
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const raw = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    raw.push(a);
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const body = a.slice(2);
    let key;
    let value;
    if (body.includes('=')) {
      const idx = body.indexOf('=');
      key = body.slice(0, idx);
      value = body.slice(idx + 1);
    } else if (body.startsWith('no-')) {
      key = body.slice(3);
      value = false;
    } else {
      key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    // 重复 flag -> 聚合成数组
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      if (Array.isArray(flags[key])) flags[key].push(value);
      else flags[key] = [flags[key], value];
    } else {
      flags[key] = value;
    }
  }
  return { cmd: positional[0] || '', flags, positional, raw };
}

const { firstOf, flagStr, flagAll, flagNum, flagBool } = require('./args');

/**
 * 打印帮助。
 * @param {string} [cmd]
 */
function printHelp(cmd) {
  const out = [];
  if (cmd && COMMANDS[cmd]) {
    out.push(`${cmd} —— ${COMMANDS[cmd].desc}`);
    out.push('');
    out.push('各命令的参数见 src/cli/cmd-*.js 顶部的 usage 注释。');
  } else {
    out.push('fgui-rb —— FGUI 自动化拼 UI 工具链（Reuse-First）');
    out.push('');
    out.push('【离线声明】本工具全程本地处理：不联网、不上传素材、不调用任何外部模型或遥测。');
    out.push('素材是公司未公开美术资产，任何出站请求都是合规事故（PRD K1）。');
    out.push('');
    out.push('用法：fgui-rb <命令> [参数]');
    out.push('');
    out.push('命令：');
    const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
    for (const k of Object.keys(COMMANDS).sort()) {
      out.push(`  ${k.padEnd(width)}  ${COMMANDS[k].desc}`);
    }
    out.push('');
    out.push('全局参数：');
    out.push('  --root <dir>         项目根目录（用于定位 fgui.config.json，默认当前目录）');
    out.push('  --config <path>      指定配置文件（默认 <root>/fgui.config.json）');
    out.push('  --out <dir>          产物输出目录（默认 <root>/out）');
    out.push('  --assets <dir>       切图素材目录（asset-* 命令用）');
    out.push('  --log-level <LVL>    DEBUG|INFO|WARN|ERROR（默认 INFO）');
    out.push('  --now <iso>          注入时间戳（ISO 8601）。作用于 run_meta.json 的 generatedAt；');
    out.push('                       确定性验证时传固定值可让 run_meta 也可复现。');
    out.push('  --help               显示本帮助');
  }
  process.stderr.write(out.join('\n') + '\n');
}

/**
 * CLI 主入口。
 *
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
async function main(argv) {
  const parsed = parseArgs(argv);
  const { cmd, flags } = parsed;

  // 显式 `--help` 视为成功：否则 CI 里 `fgui-rb --help` 返回非零会被误判为失败
  if (flags.help === true) {
    printHelp(typeof cmd === 'string' ? cmd : '');
    return EXIT.OK;
  }
  if (!cmd) {
    // 无参数直接跑：打印帮助并返回「用法错误」，让脚本能区分「求助」与「误用」
    printHelp();
    return EXIT.USAGE;
  }
  if (cmd === 'help') {
    printHelp(flags.topic ? String(flags.topic) : '');
    return EXIT.OK;
  }

  const entry = COMMANDS[cmd];
  if (!entry) {
    process.stderr.write(`未知命令: ${cmd}\n\n`);
    printHelp();
    return EXIT.USAGE;
  }

  const rootDir = path.resolve(flagStr(flags.root, process.cwd()));
  const { config, configPath, existed } = loadConfig({
    rootDir,
    configPath: flags.config ? path.resolve(rootDir, flagStr(flags.config)) : undefined,
  });

  const logger = createLogger({
    level: flagStr(flags["log-level"], "INFO"),
    module: cmd,
  });
  if (!flagBool(flags.quiet, false)) logger.printOfflineNotice();
  if (!existed) {
    logger.warn('未找到 fgui.config.json，使用内置默认阈值', { root: rootDir });
  }

  const ctx = {
    flags,
    positional: parsed.positional.slice(1),
    config,
    configPath,
    logger,
    rootDir,
    // `now` 注入：.bak 文件名用；确定性验证时传固定值（B9 / ARCHITECTURE 决策 13）
    now: flagStr(flags.now),
    // 参数取值助手（重复 flag 会是数组，务必经由它们取第一个值）
    flagStr,
    flagAll,
    flagNum,
    flagBool,
    // 向后兼容别名
    num: flagNum,
    bool: flagBool,
  };

  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(entry.module);
    const code = await mod.run(ctx);
    return typeof code === 'number' ? code : EXIT.OK;
  } catch (err) {
    const appErr = toAppError(err);
    logger.error(`${cmd} 失败`, { code: appErr.code, msg: appErr.message });
    if (appErr.details && Object.keys(appErr.details).length) {
      logger.error('details', appErr.details);
    }
    if (!(err instanceof AppError)) {
      // 非 AppError 说明是未预期异常，附堆栈（§8.1：可恢复降级，不可恢复上抛）
      process.stderr.write(String(err.stack || err) + '\n');
    }
    return appErr.exitCode;
  }
}

module.exports = { main, parseArgs, printHelp, COMMANDS, firstOf, flagStr, flagAll, flagNum, flagBool };
