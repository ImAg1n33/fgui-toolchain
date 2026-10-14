'use strict';
/**
 * src/core/errors.js —— 跨模块错误约定（ARCHITECTURE §8.1）
 *
 * 所有跨模块边界的错误一律用 AppError，携带机器可读 code 与人可读 message。
 * 模块内部可以 throw new Error()（不处理），但跨边界必须转换。
 */

/** 错误码 -> 退出码。小 Q 用 PowerShell 判断「是否需要人工介入」。 */
const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  LINT_BLOCKED: 3,
  NEEDS_HUMAN: 4,
  ROLLED_BACK: 5,
});

/** 错误码常量表，避免各处拼错字符串 */
const CODES = Object.freeze({
  OK: 'OK',
  INTERNAL: 'INTERNAL',
  USAGE: 'USAGE',
  LINT_BLOCKED: 'LINT_BLOCKED',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  ROLLED_BACK: 'ROLLED_BACK',

  // 参数类
  BAD_ARGUMENT: 'BAD_ARGUMENT',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  CONFIG_INVALID: 'CONFIG_INVALID',

  // 文件类
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  READ_FAILED: 'READ_FAILED',
  WRITE_FAILED: 'WRITE_FAILED',

  // 依赖类
  DEP_MISSING: 'DEP_MISSING',
  DECODER_UNAVAILABLE: 'DECODER_UNAVAILABLE',

  // 业务类
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  NO_SOURCE_LAYERS: 'NO_SOURCE_LAYERS',
  PSD_PARSE_FAILED: 'PSD_PARSE_FAILED',
});

/**
 * 应用级错误。
 * @extends Error
 */
class AppError extends Error {
  /**
   * @param {string} code 大写下划线常量，见 CODES
   * @param {string} message 人可读描述（中文）
   * @param {Object} [details] 结构化补充信息，会进日志与 run_meta
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details || {};
  }

  /** @returns {number} 对应退出码 */
  get exitCode() {
    return EXIT[this.code] !== undefined ? EXIT[this.code] : EXIT.INTERNAL;
  }

  /** @returns {Object} 可直接 JSON 序列化的结构 */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * 把任意异常包装成 AppError。已是 AppError 则原样返回。
 * @param {unknown} err
 * @param {string} [fallbackCode]
 * @returns {AppError}
 */
function toAppError(err, fallbackCode = CODES.INTERNAL) {
  if (err instanceof AppError) return err;
  const message = err && err.message ? err.message : String(err);
  const wrapped = new AppError(fallbackCode, message, {
    originalName: err && err.name ? err.name : 'Unknown',
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : '',
  });
  return wrapped;
}

/**
 * 断言参数满足条件，不满足则抛 USAGE 错误。
 * @param {boolean} condition
 * @param {string} message
 * @param {Object} [details]
 */
function assertUsage(condition, message, details) {
  if (!condition) throw new AppError(CODES.USAGE, message, details);
}

module.exports = { AppError, CODES, EXIT, toAppError, assertUsage };
