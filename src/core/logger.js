'use strict';
/**
 * src/core/logger.js —— 结构化日志（ARCHITECTURE §8.2）
 *
 * 铁律：
 *   1. 日志走 **stderr**，产物数据走 stdout（这样 `fgui-rb asset-index > report.json` 拿到干净 JSON）。
 *   2. 产物 JSON 内不可有时间戳；日志可以有。
 *   3. 禁止打印图片内容/字节数据；路径一律 POSIX 相对化（不打印公司素材绝对路径，PRD K1）。
 */

const LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 });

/** @param {string} name @returns {number} */
function levelValue(name) {
  return LEVELS[String(name || 'INFO').toUpperCase()] || LEVELS.INFO;
}

/**
 * 把任意值转成日志友好的 key=value 片段。
 * 字符串中的空格会破坏 key=value 解析，故替换为下划线。
 * @param {unknown} value
 * @returns {string}
 */
function fmtValue(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(fmtValue).join(',')}]`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value).replace(/\s+/g, '_');
}

/**
 * 结构化日志器。默认写到 process.stderr。
 */
class Logger {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.level] DEBUG|INFO|WARN|ERROR
   * @param {string} [opts.module] 模块名，日志行里的第二个字段
   * @param {Function} [opts.sink] 自定义输出流，测试用
   * @param {Function} [opts.clock] 自定义时钟，测试用（返回 Date）
   */
  constructor(opts = {}) {
    this.level = levelValue(opts.level);
    this.module = opts.module || 'fgui';
    this._sink = opts.sink || ((line) => process.stderr.write(line + '\n'));
    this._clock = opts.clock || (() => new Date());
  }

  /**
   * 派生子日志器，继承 level 与 sink，改 module。
   * @param {string} moduleName
   * @returns {Logger}
   */
  child(moduleName) {
    return new Logger({
      level: Object.keys(LEVELS).find((k) => LEVELS[k] === this.level) || 'INFO',
      module: moduleName,
      sink: this._sink,
      clock: this._clock,
    });
  }

  /**
   * @param {string} level
   * @param {string} message
   * @param {Object} [fields] 附加 key=value
   */
  log(level, message, fields) {
    const lv = levelValue(level);
    if (lv < this.level) return;
    const ts = this._clock().toISOString();
    const lvName = Object.keys(LEVELS).find((k) => LEVELS[k] === lv) || 'INFO';
    let line = `[${ts}] ${lvName.padEnd(5)} ${this.module} ${fmtValue(message)}`;
    if (fields && typeof fields === 'object') {
      for (const key of Object.keys(fields).sort()) {
        line += ` ${key}=${fmtValue(fields[key])}`;
      }
    }
    this._sink(line);
  }

  /** @param {string} m @param {Object} [f] */
  debug(m, f) { this.log('DEBUG', m, f); }
  /** @param {string} m @param {Object} [f] */
  info(m, f) { this.log('INFO', m, f); }
  /** @param {string} m @param {Object} [f] */
  warn(m, f) { this.log('WARN', m, f); }
  /** @param {string} m @param {Object} [f] */
  error(m, f) { this.log('ERROR', m, f); }

  /**
   * 打印「本工具不联网」声明（PRD K1 第③条：CLI 显式打印）。
   */
  printOfflineNotice() {
    this._sink('[offline] fgui-rb 全程本地处理：不联网、不上传素材、不调用任何外部模型或遥测。');
  }
}

/** @returns {Logger} 默认 INFO 级日志器 */
function createLogger(opts) {
  return new Logger(opts);
}

/** 静默日志器（测试用） */
function nullLogger() {
  const noop = () => {};
  return new Logger({ level: 'ERROR', module: 'null', sink: noop });
}

module.exports = { Logger, createLogger, nullLogger, LEVELS, fmtValue };
