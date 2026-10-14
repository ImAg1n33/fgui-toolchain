'use strict';
/**
 * test/unit/fgui-transaction.test.js —— P1-a-03 事务化写盘单测
 *
 * 覆盖 ARCHITECTURE §4.3 的 8 步序列：
 *   ② lint 门禁（error → 退出码 3，不动磁盘）
 *   ③④ tmp 写 + 复检（复检失败 → 删 tmp，退出码 3）
 *   ⑤ .bak 备份（now 注入决定文件名，B9）
 *   ⑥ 原子替换
 *   ⑦ 写后校验失败 → 回滚（退出码 5）
 *   ⑧ reload_hint
 * 另覆盖 package.xml 硬约束（API 级拒绝）与 B9 确定性（同 now → 同结果）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeComponentXml, writePackageXml, rollback, assertLintClean, RELOAD_HINT,
} = require('../../src/fgui/transaction');
const { AppError, CODES, EXIT } = require('../../src/core/errors');
const { legalComponentXml, RESOURCES, violationSamples } = require('../fixtures/fgui-samples');

/** 每个测试独立的临时目录。 */
function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fgui-tx-${name}-`));
}

/** 固定的注入时间（B9：.bak 名可复现）。 */
const NOW = '2026-05-13T10:20:30.123Z';

test('② lint 门禁: 有 error 的 XML 不写盘、抛 LINT_BLOCKED（退出码 3）', () => {
  const dir = tmpDir('lintblock');
  const target = path.join(dir, 'MailDetail.xml');
  const bad = violationSamples()['R-03-8bit'].xml;

  assert.throws(() => writeComponentXml({
    targetPath: target, content: bad, now: NOW, resources: RESOURCES,
  }), (err) => {
    assert.ok(err instanceof AppError, '应抛 AppError');
    assert.equal(err.code, CODES.LINT_BLOCKED);
    assert.equal(err.exitCode, EXIT.LINT_BLOCKED);
    assert.equal(EXIT.LINT_BLOCKED, 3);
    assert.ok(err.message.includes('8 位色'), '错误信息应可读（含具体规则说明）');
    assert.ok(err.details && Array.isArray(err.details.errors) && err.details.errors.length > 0,
      'details 应带完整 errors 供上层展示');
    return true;
  });

  // 磁盘零痕迹：没有目标、没有 tmp、没有 bak
  assert.equal(fs.existsSync(target), false, '目标文件不应被创建');
  assert.equal(fs.existsSync(`${target}.tmp`), false, '不应残留 tmp');
  const leftovers = fs.readdirSync(dir);
  assert.equal(leftovers.length, 0, `目录应保持为空，实际: ${leftovers}`);
});

test('★ BUG-A 事务层: 越界实体 XML 抛 AppError（LINT_BLOCKED）而非裸 RangeError', () => {
  // QA 第三轮：越界实体原会抛未捕获 RangeError 冲出事务层（退出码契约失效）。
  // 修复后必须走 lint 门禁 → AppError(LINT_BLOCKED)，磁盘零痕迹。
  const dir = tmpDir('buga');
  const target = path.join(dir, 'C.xml');
  const xml = '<component exported="true"><displayList>'
    + '<text id="b00001" name="t" text="&#x1F6000;"/></displayList></component>';

  assert.throws(() => writeComponentXml({
    targetPath: target, content: xml, now: NOW, resources: RESOURCES,
  }), (err) => {
    assert.ok(err instanceof AppError, `★ 必须是 AppError 而不是裸异常，实际: ${err.name}`);
    assert.equal(err.code, CODES.LINT_BLOCKED);
    assert.equal(err.exitCode, 3, '退出码契约必须保持（3 = lint 阻断未写盘）');
    assert.ok(err.message.includes('码点') && err.message.includes('越界'),
      '门禁信息应可读（点名越界码点）');
    return true;
  });
  assert.equal(fs.existsSync(target), false, '磁盘零痕迹');
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('⑧ 成功写盘: 内容落盘 + 结果字段齐全 + reload_hint 非空', () => {
  const dir = tmpDir('ok');
  const target = path.join(dir, 'MailDetail.xml');
  const xml = legalComponentXml();

  const r = writeComponentXml({ targetPath: target, content: xml, now: NOW, resources: RESOURCES });

  assert.equal(r.applied, true);
  assert.equal(r.targetPath, target);
  assert.equal(r.bytes, Buffer.byteLength(xml, 'utf8'));
  assert.equal(r.backupPath, null, '目标首次创建，无备份');
  assert.equal(r.lint.errors, 0);
  assert.equal(r.lint.warnings, 0);
  assert.equal(r.now, NOW);
  assert.ok(r.reloadHint && r.reloadHint.length > 20, 'reload_hint 必须非空且可读');
  assert.ok(/重启|refresh/.test(r.reloadHint), 'reload_hint 应提示重启/refresh');
  assert.equal(fs.readFileSync(target, 'utf8'), xml, '盘上内容应与候选逐字节一致');
});

test('⑤ 覆盖写: 生成 .bak.<注入时间戳>，且原内容可在备份里找到', () => {
  const dir = tmpDir('bak');
  const target = path.join(dir, 'MailDetail.xml');
  const original = legalComponentXml();
  fs.writeFileSync(target, original, 'utf8');

  const updated = original.replace('邮件详情', '邮件详情(改)');
  const r = writeComponentXml({ targetPath: target, content: updated, now: NOW, resources: RESOURCES });

  assert.ok(r.backupPath, '覆盖写必须留备份');
  assert.equal(path.basename(r.backupPath), 'MailDetail.xml.bak.20260513T102030123Z',
    '.bak 名必须用注入的 now（B9：同 now → 同文件名）');
  assert.equal(fs.readFileSync(r.backupPath, 'utf8'), original, '备份内容应是覆盖前的内容');
  assert.equal(fs.readFileSync(target, 'utf8'), updated, '目标应是新内容');
});

test('⑤ B9: 同 now 两次覆盖写，结果对象与备份名完全一致', () => {
  const dirA = tmpDir('b9a');
  const dirB = tmpDir('b9b');
  const xml = legalComponentXml();

  const prep = (dir) => {
    const target = path.join(dir, 'C.xml');
    fs.writeFileSync(target, 'old', 'utf8');
    return target;
  };
  const rA = writeComponentXml({ targetPath: prep(dirA), content: xml, now: NOW, resources: RESOURCES });
  const rB = writeComponentXml({ targetPath: prep(dirB), content: xml, now: NOW, resources: RESOURCES });
  // 路径不同，其余字段应完全一致（备份名只取决于 now，不含路径）
  assert.deepEqual(
    { ...rA, targetPath: null, backupPath: path.basename(rA.backupPath) },
    { ...rB, targetPath: null, backupPath: path.basename(rB.backupPath) },
  );
  // 两次运行产物内容逐字节一致
  assert.equal(
    fs.readFileSync(path.join(dirA, 'C.xml'), 'utf8'),
    fs.readFileSync(path.join(dirB, 'C.xml'), 'utf8'),
  );
});

test('④ tmp 复检失败: 删 tmp、不碰目标、抛 LINT_BLOCKED', () => {
  const dir = tmpDir('verify');
  const target = path.join(dir, 'C.xml');
  const xml = legalComponentXml();

  // 注入一个必然失败的 verify（模拟「写入截断/编码损坏」）
  assert.throws(() => writeComponentXml({
    targetPath: target, content: xml, now: NOW, resources: RESOURCES,
    verify: () => '模拟 tmp 损坏',
  }), (err) => {
    assert.equal(err.code, CODES.LINT_BLOCKED);
    assert.ok(err.message.includes('模拟 tmp 损坏'), '失败原因应透出');
    return true;
  });
  assert.equal(fs.existsSync(target), false, '目标不应被创建');
  assert.equal(fs.existsSync(`${target}.tmp`), false, 'tmp 必须被清理');
  assert.equal(fs.readdirSync(dir).length, 0, '目录应无残留');
});

test('⑦ 写后校验失败: 用 .bak 回滚、抛 ROLLED_BACK（退出码 5）', () => {
  const dir = tmpDir('rollback');
  const target = path.join(dir, 'C.xml');
  const original = legalComponentXml();
  fs.writeFileSync(target, original, 'utf8');

  assert.throws(() => writeComponentXml({
    targetPath: target,
    content: original.replace('邮件详情', '新标题'),
    now: NOW,
    resources: RESOURCES,
    postVerify: () => '模拟写后校验失败',
  }), (err) => {
    assert.equal(err.code, CODES.ROLLED_BACK);
    assert.equal(err.exitCode, EXIT.ROLLED_BACK);
    assert.equal(EXIT.ROLLED_BACK, 5);
    assert.equal(err.details.restored, true, '应标记已回滚');
    return true;
  });

  assert.equal(fs.readFileSync(target, 'utf8'), original,
    '★ 回滚后目标必须是**原内容**（事务的核心承诺）');
  const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
  assert.equal(baks.length, 1, '应留有备份供人工检查');
  assert.equal(fs.readFileSync(path.join(dir, baks[0]), 'utf8'), original);
});

test('⑦ 无备份时写后校验失败: 明确报错（不假装回滚成功）', () => {
  const dir = tmpDir('rollback-nobak');
  const target = path.join(dir, 'C.xml'); // 目标不存在 → 无 .bak

  assert.throws(() => writeComponentXml({
    targetPath: target, content: legalComponentXml(), now: NOW, resources: RESOURCES,
    postVerify: () => '模拟失败',
  }), (err) => {
    assert.equal(err.code, CODES.ROLLED_BACK);
    assert.equal(err.details.restored, false, '没有备份时 restored 必须为 false');
    return true;
  });
});

test('★ package.xml 硬约束: 事务层与显式 API 双重拒绝', () => {
  const dir = tmpDir('pkgxml');
  // 1) writeComponentXml 拒绝 package.xml 路径
  assert.throws(() => writeComponentXml({
    targetPath: path.join(dir, 'package.xml'), content: legalComponentXml(), now: NOW,
  }), (err) => {
    assert.equal(err.code, CODES.USAGE);
    assert.ok(err.message.includes('内存态覆盖'), '必须说明上游事故机理');
    assert.ok(err.message.includes('create_package'), '必须给出正确路径（编辑器 API）');
    return true;
  });
  assert.equal(fs.existsSync(path.join(dir, 'package.xml')), false);
  // 2) 显式 writePackageXml 永远抛出（设计意图：让约束在 API 表面可见）
  assert.throws(() => writePackageXml(path.join(dir, 'package.xml')), (err) => {
    assert.equal(err.code, CODES.USAGE);
    assert.ok(err.message.includes('内存态覆盖'));
    return true;
  });
  // 3) 大小写变体也要拦（Package.xml / PACKAGE.XML）
  assert.throws(() => writeComponentXml({
    targetPath: path.join(dir, 'Package.XML'), content: legalComponentXml(), now: NOW,
  }), (err) => err.code === CODES.USAGE);
});

test('★ BUG-B: package.xml 黑名单 trim —— 尾随/前导空格变体必须拦截', () => {
  // QA 第三轮实测：'package.xml '（尾随空格）在 Windows 上 OS 会剥掉空格
  // 落成真 package.xml —— 黑名单比对前必须 trim。
  const variants = [
    'package.xml ',      // 尾随空格（QA 实测可落盘的形态）
    ' package.xml',      // 前导空格
    '  package.xml  ',   // 两侧空白
    'Package.XML ',      // 大小写 + 尾随空格
    '\tpackage.xml',     // tab
    './package.xml ',    // 带目录前缀 + 尾随空格
    'a/b/package.xml ',  // 嵌套路径 + 尾随空格
  ];
  for (const name of variants) {
    const dir = tmpDir('pkgxml-trim');
    try {
      assert.throws(() => writeComponentXml({
        targetPath: path.join(dir, name), content: legalComponentXml(), now: NOW,
      }), (err) => {
        assert.equal(err.code, CODES.USAGE,
          `变体 ${JSON.stringify(name)} 应被拦（BUG-B：未 trim 时漏拦）`);
        assert.ok(err.message.includes('内存态覆盖'));
        return true;
      });
      // 落盘检查：不允许任何伪装成 package.xml 的文件
      const files = fs.readdirSync(dir);
      assert.equal(files.length, 0,
        `变体 ${JSON.stringify(name)} 被拦后目录应为空，实际: ${files}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // 正对照：普通 XML 名（带空格的合法文件名）不受影响
  const dir2 = tmpDir('pkgxml-ok');
  try {
    const r = writeComponentXml({
      targetPath: path.join(dir2, 'MailDetail .xml'), content: legalComponentXml(), now: NOW, resources: RESOURCES,
    });
    assert.equal(r.applied, true, '合法文件名（含空格）不应被误拦');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('告警不阻断: 只有 warning 的 XML 正常写盘', () => {
  const dir = tmpDir('warn');
  const target = path.join(dir, 'C.xml');
  // R-05 负值样本：warning 级，不应阻断
  const warnOnly = violationSamples()['R-05-negative'].xml;
  const r = writeComponentXml({ targetPath: target, content: warnOnly, now: NOW, resources: RESOURCES });
  assert.equal(r.applied, true);
  assert.equal(r.lint.warnings, 1, '应记录 1 条 warning');
  assert.equal(r.lint.errors, 0);
  assert.ok(r.reloadHint);
});

test('rollback 能力暴露: 可从 .bak 手工恢复', () => {
  const dir = tmpDir('manual-rollback');
  const target = path.join(dir, 'C.xml');
  const original = legalComponentXml();
  fs.writeFileSync(target, original, 'utf8');
  const r = writeComponentXml({
    targetPath: target, content: original.replace('邮件详情', '改'), now: NOW, resources: RESOURCES,
  });
  assert.ok(r.backupPath);

  // 人工把目标改坏，再用 rollback 恢复
  fs.writeFileSync(target, 'corrupted', 'utf8');
  const res = rollback(r.backupPath, target);
  assert.equal(res.restored, true);
  assert.equal(fs.readFileSync(target, 'utf8'), original, '恢复后应是备份内容');

  // 备份不存在时明确返回 restored:false（不抛异常、不静默成功）
  const res2 = rollback(path.join(dir, 'nope.bak'), target);
  assert.equal(res2.restored, false);
});

test('assertLintClean: 干净内容原样返回结果；脏内容抛错', () => {
  const ok = assertLintClean(legalComponentXml(), { resources: RESOURCES });
  assert.equal(ok.ok, true);
  assert.throws(() => assertLintClean('not xml at all', { resources: RESOURCES }),
    (err) => err.code === CODES.LINT_BLOCKED);
});

test('参数防御: 缺 targetPath / content 抛 BAD_ARGUMENT', () => {
  assert.throws(() => writeComponentXml({ content: 'x', now: NOW }),
    (err) => err.code === CODES.BAD_ARGUMENT);
  assert.throws(() => writeComponentXml({ targetPath: '/tmp/x.xml', now: NOW }),
    (err) => err.code === CODES.BAD_ARGUMENT);
});

test('RELOAD_HINT 常量: 覆盖关编辑器 + refresh 两个动作', () => {
  assert.ok(RELOAD_HINT.includes('重启编辑器'));
  assert.ok(RELOAD_HINT.includes('refresh'));
  assert.ok(RELOAD_HINT.includes('package.xml'), '提示里必须带 package.xml 约束');
});
