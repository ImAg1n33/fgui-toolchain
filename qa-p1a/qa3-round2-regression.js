'use strict';
/**
 * qa-p1a/qa3-round2-regression.js —— QA 第三轮·第 2 轮回归（对工程师的 3 个 bug 修复）
 *
 * 核心问题：修复是真的修好了，还是表面绿？
 * 方法：变异测试 —— 把每个修复改回旧行为，断言相关测试必须变红，恢复后复绿。
 *
 * 变异清单：
 *   M-A1 BUG-A 主修复回退（去掉码点上界校验；兜底 try/catch 仍在）
 *   M-A2 BUG-A 完全回退（去码点上界 + 去 try/catch = 原始崩溃形态）
 *   M-B  BUG-B 修复回退（basename 不去 trim）
 *   M-D1 BUG-D 读路径回退（format 改回 toUpperCase）
 *   M-D2 BUG-D 读路径回退（suggestedGrid 改回硬编码 null）
 *   M-D3 BUG-D 迁移回退（migrateAssetColumns 改 no-op）
 *
 * 另加「修复是否引入新问题」探针（不变异，直接测现行为）：
 *   P-1 越界实体原样保留后，R-08 对含实体的 name 不误判、R-00 仍抓
 *   P-2 firstUiRef 大小写不敏感：大写 UI:// 走完整校验；文本内容里的 ui:// 不误伤
 *   P-3 无引号属性值里的越界实体：文档仍被 error 拦截（已知上报缺口记录）
 *   P-4 CDATA 内的实体文本不误报（CDATA 是字面量，合法）
 *   P-5 execDdlTolerant：远古 schema（缺 phash 列）打开不阻，但 upsert 会抛
 *       （记录真实行为：「打开不阻断」成立，「任意旧库都能用」不成立）
 *   P-6 增量路径其他产物：contact_sheet.html / run_meta 二次运行稳定性
 *   P-7 真·P0 旧 schema 库端到端：CLI 跑两次，map.json 一致且迁移生效
 *
 * 运行：node qa-p1a/qa3-round2-regression.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = 'C:/Program Files/nodejs/node.exe';
const GOLDEN = path.join(ROOT, 'test/fixtures/golden');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, evidence) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${evidence ? ' :: ' + evidence : ''}`);
  }
}

const FILES = {
  lint: 'src/fgui/lint-rules.js',
  tx: 'src/fgui/transaction.js',
  store: 'src/assets/store.js',
  indexer: 'src/assets/indexer.js',
};
const TESTS = {
  lint: 'test/unit/lint-rules.test.js',
  tx: 'test/unit/fgui-transaction.test.js',
  inc: 'test/unit/asset-index-incremental.test.js',
};

function runTest(file) {
  try {
    execFileSync(NODE, ['--disable-warning=ExperimentalWarning', '--test', file],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** 备份→变异→跑测试→恢复，返回 {caught, failedTests, restoreOk}。 */
function withMutation(fileKey, from, to, testKey, expectFailNames) {
  const filePath = path.join(ROOT, FILES[fileKey]);
  const original = fs.readFileSync(filePath, 'utf8');
  if (!original.includes(from)) {
    return { anchorMissing: true };
  }
  const mutated = original.replace(from, to);
  if (mutated === original) return { anchorMissing: true };
  fs.writeFileSync(filePath, mutated, 'utf8');
  let r;
  try {
    r = runTest(TESTS[testKey]);
  } finally {
    fs.writeFileSync(filePath, original, 'utf8');
  }
  const failed = [...r.out.matchAll(/^✖ (.+)$/gm)].map((x) => x[1].trim());
  const caught = expectFailNames.filter((n) => failed.some((f) => f.includes(n)));
  return {
    code: r.code,
    failed,
    caught,
    restoreOk: fs.readFileSync(filePath, 'utf8') === original,
  };
}

// ════════════════════════════════════════════════════════════════════════
console.log('=== R2-0. 基线：三个目标测试文件全绿 ===');
{
  for (const [k, f] of Object.entries(TESTS)) {
    const r = runTest(f);
    ok(`基线 ${f} 全绿`, r.code === 0, r.out.slice(-200));
  }
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== R2-1. BUG-A 变异：修复回退后测试必须红 ===');
{
  // M-A1：只去码点上界校验（兜底 try/catch 仍在）→ 具体码点信息断言必红
  const m1 = withMutation('lint',
    'code < 0 || code > MAX_CODE_POINT',
    'code < 0',
    'lint',
    ['BUG-A']);
  const bugAFailed = (m1.failed || []).filter((f) => f.includes('BUG-A')).length;
  ok('M-A1 去码点上界校验 → BUG-A 测试变红', !m1.anchorMissing && m1.code !== 0 && bugAFailed >= 3,
    `exit=${m1.code} BUG-A 失败数=${bugAFailed} failed=${JSON.stringify((m1.failed || []).slice(0, 5))}`);
  ok('M-A1 恢复后复绿', m1.restoreOk && runTest(TESTS.lint).code === 0);

  // M-A2：完全回退 = 原始崩溃形态（去上界 + 去 try/catch）
  const tryCatchBlock = [
    '    try {',
    '      parsed = parseXmlDocument(xml);',
    '    } catch (err) {',
    '      parsed = {',
    '        root: null,',
    '        decl: null,',
    '        errors: [{',
    '          message: `XML 解析器未预期失败（这是工具缺陷，已按结构错误拦截而非崩溃）：${err.message}`,',
    '          line: 1, col: 1,',
    '        }],',
    '      };',
    '    }',
  ].join('\n');
  const m2 = withMutation('lint',
    tryCatchBlock,
    '    parsed = parseXmlDocument(xml);',
    'lint',
    ['BUG-A']);
  // 注意：此变异保留了码点上界校验，所以不崩溃、但具体信息断言… 等等——
  // 码点上界还在 → 实体被正确上报 → 测试仍可能绿。这是预期的：
  // M-A2 的真实形态应该是「两个修复都回退」。分两步做：
  ok('M-A2a 仅去 try/catch（上界校验仍在）→ 测试仍绿（说明上界校验是主修复）',
    !m2.anchorMissing && m2.code === 0,
    `exit=${m2.code}（若红说明 try/catch 也是主修复，需重新评估）`);

  // M-A2b：两个修复都回退 → 必须红（doesNotThrow 失败）
  const lintSrc = fs.readFileSync(path.join(ROOT, FILES.lint), 'utf8');
  const fullyReverted = lintSrc
    .replace('code < 0 || code > MAX_CODE_POINT', 'code < 0')
    .replace(tryCatchBlock, '    parsed = parseXmlDocument(xml);');
  fs.writeFileSync(path.join(ROOT, FILES.lint), fullyReverted, 'utf8');
  let r2b;
  try {
    r2b = runTest(TESTS.lint);
  } finally {
    fs.writeFileSync(path.join(ROOT, FILES.lint), lintSrc, 'utf8');
  }
  const failed2b = [...r2b.out.matchAll(/^✖ (.+)$/gm)].map((x) => x[1].trim());
  const bugA2b = failed2b.filter((f) => f.includes('BUG-A')).length;
  ok('M-A2b 完全回退（原始崩溃形态）→ BUG-A 测试变红',
    r2b.code !== 0 && bugA2b >= 3,
    `exit=${r2b.code} BUG-A 失败数=${bugA2b} failed=${JSON.stringify(failed2b.slice(0, 5))}`);
  ok('M-A2b 恢复后复绿', fs.readFileSync(path.join(ROOT, FILES.lint), 'utf8') === lintSrc
    && runTest(TESTS.lint).code === 0);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== R2-2. BUG-B 变异：trim 回退后测试必须红 ===');
{
  const m = withMutation('tx',
    'path.basename(String(targetPath)).trim().toLowerCase()',
    'path.basename(String(targetPath)).toLowerCase()',
    'tx',
    ['BUG-B']);
  ok('M-B 去 trim → BUG-B 测试变红', !m.anchorMissing && m.code !== 0 && m.caught.length >= 1,
    `exit=${m.code} caught=${JSON.stringify(m.caught)}`);
  ok('M-B 恢复后复绿', m.restoreOk && runTest(TESTS.tx).code === 0);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== R2-3. BUG-D 变异：三个修复点逐一回退 ===');
{
  // M-D1：读路径 format 改回大写
  const m1 = withMutation('store',
    "format: String(row.format || '').toLowerCase(),",
    "format: String(row.format || '').toUpperCase(),",
    'inc',
    ['BUG-D']);
  const d1Failed = (m1.failed || []).filter((f) => f.includes('BUG-D')).length;
  ok('M-D1 format 读路径回退大写 → BUG-D 测试变红', !m1.anchorMissing && m1.code !== 0 && d1Failed >= 3,
    `exit=${m1.code} BUG-D 失败数=${d1Failed} failed=${JSON.stringify((m1.failed || []).slice(0, 4))}`);
  ok('M-D1 恢复后复绿', m1.restoreOk && runTest(TESTS.inc).code === 0);

  // M-D2：suggestedGrid 改回硬编码 null
  const m2 = withMutation('store',
    'suggestedGrid: row.grid9_suggested_grid || null,',
    'suggestedGrid: null,',
    'inc',
    ['BUG-D']);
  const d2Failed = (m2.failed || []).filter((f) => f.includes('BUG-D')).length;
  ok('M-D2 suggestedGrid 回退硬编码 null → BUG-D 测试变红', !m2.anchorMissing && m2.code !== 0 && d2Failed >= 3,
    `exit=${m2.code} BUG-D 失败数=${d2Failed} failed=${JSON.stringify((m2.failed || []).slice(0, 4))}`);
  ok('M-D2 恢复后复绿', m2.restoreOk && runTest(TESTS.inc).code === 0);

  // M-D3：迁移改 no-op
  const m3 = withMutation('store',
    "function migrateAssetColumns(db) {\r\n  const cols",
    "function migrateAssetColumns(db) {\r\n  return;\r\n  const cols",
    'inc',
    ['迁移']);
  const m3b = m3.anchorMissing ? withMutation('store',
    "function migrateAssetColumns(db) {\n  const cols",
    "function migrateAssetColumns(db) {\n  return;\n  const cols",
    'inc',
    ['迁移']) : m3;
  ok('M-D3 迁移回退 no-op → 迁移测试变红', !m3b.anchorMissing && m3b.code !== 0 && m3b.caught.length >= 1,
    `exit=${m3b.code} caught=${JSON.stringify(m3b.caught)}`);
  ok('M-D3 恢复后复绿', m3b.restoreOk && runTest(TESTS.inc).code === 0);

  // M-D4（覆盖侦察）：indexer 写路径去掉 toLowerCase —— 现有 fixture 全是 .png
  // （decoder 返回小写），预计**抓不到**。若绿，说明写路径归一只有防御价值、
  // 没有测试守护（.PNG 大写扩展名 fixture 缺失）——记录为覆盖缺口。
  const m4 = withMutation('indexer',
    "format: String(size.format || path.extname(abs).slice(1)).toLowerCase(),",
    "format: String(size.format || path.extname(abs).slice(1)),",
    'inc',
    ['BUG-D']);
  ok('M-D4 侦察：写路径去 toLowerCase 现无测试守护（预期绿，记为覆盖缺口）',
    !m4.anchorMissing && m4.code === 0,
    `exit=${m4.code}（若红说明有我不知道的 .PNG fixture，则本条改为通过性记录）`);
  ok('M-D4 恢复后复绿', m4.restoreOk && runTest(TESTS.inc).code === 0);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== R2-4. BUG-A 修复的新问题探针（现行为，不变异）===');
{
  const { lintComponentXml, parseXmlDocument } = require('../src/fgui/lint-rules');
  const byRule = (r, id) => [...r.errors, ...r.warnings].filter((i) => i.rule === id);

  // P-1：name 含越界实体 → R-00 抓、R-08 不误判（原样保留的实体文本不命中禁用模式）
  {
    const xml = '<component exported="true"><displayList>'
      + '<text id="b00001" name="&#x110000;" text="x"/>'
      + '<text id="b00002" name="n&#x110000;0" text="y"/>'
      + '</displayList></component>';
    const r = lintComponentXml(xml, {});
    ok('P-1a name 含越界实体 → R-00 抓到', byRule(r, 'R-00').length === 2,
      JSON.stringify(byRule(r, 'R-00').map((i) => i.message.slice(0, 40))));
    ok('P-1b R-08 不因原样实体文本误判（n&#x110000;0 不是 n0）', byRule(r, 'R-08').length === 0,
      JSON.stringify(byRule(r, 'R-08').map((i) => i.message.slice(0, 40))));
  }

  // P-2：大小写不敏感 firstUiRef —— 大写 UI:// 走完整校验；文本内容不误伤
  {
    const xml = '<component exported="true"><displayList>'
      + '<image id="b00001" name="bg" src="UI://abc123/x" xy="0,0" size="10,10"/>'
      + '<text id="b00002" name="t" text="引用写法是 ui://包id/名字，不是资源"/>'
      + '</displayList></component>';
    const r = lintComponentXml(xml, {});
    const r04 = byRule(r, 'R-04');
    ok('P-2a 大写 UI:// 的 3 位包 id 被 R-04 抓到（原绕过路径已闭合）',
      r04.length === 1 && r04[0].message.includes('abc123'),
      JSON.stringify(r04.map((i) => i.message.slice(0, 50))));
    ok('P-2b 文本内容里的 ui:// 不触发 R-04（只查 url 属性）',
      !r04.some((i) => i.message.includes('名字')), '文本被误当引用');
    // 大写但合法的 8 位包 id → 放行
    const xml2 = '<component exported="true"><displayList>'
      + '<image id="b00001" name="bg" src="UI://abcd1234/x" xy="0,0" size="10,10"/>'
      + '</displayList></component>';
    const r2 = lintComponentXml(xml2, {});
    ok('P-2c 大写 UI:// + 合法 8 位包 id → 不误报', byRule(r2, 'R-04').length === 0 && r2.ok,
      JSON.stringify(r2.errors.map((e) => e.message.slice(0, 40))));
  }

  // P-3：无引号属性值里的越界实体 —— 文档仍被 error 拦截，但无专门码点信息（记录）
  {
    const xml = '<component exported="true"><displayList>'
      + '<text id="b00001" name="t" text=&#x110000; />'
      + '</displayList></component>';
    const r = lintComponentXml(xml, {});
    ok('P-3 无引号值含越界实体：文档仍 error（未加引号已拦），码点专报缺失（记录）',
      r.ok === false && byRule(r, 'R-00').some((i) => i.message.includes('未加引号')),
      JSON.stringify(byRule(r, 'R-00').map((i) => i.message.slice(0, 40))));
  }

  // P-4：CDATA 内实体文本不误报（CDATA 是字面量）
  {
    const xml = '<component exported="true"><displayList>'
      + '<graph id="b00001" name="g"><![CDATA[&#x110000; 是字面文本]]></graph>'
      + '</displayList></component>';
    const r = lintComponentXml(xml, {});
    ok('P-4 CDATA 内的实体文本不误报（字面量语义）', r.errors.length === 0,
      JSON.stringify(r.errors.map((e) => e.message.slice(0, 40))));
  }
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== R2-5. execDdlTolerant 探针：降级到底降什么 ===');
{
  const { DatabaseSync } = require('node:sqlite');
  const { AssetStore } = require('../src/assets/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-r2-ancient-'));
  const dbPath = path.join(dir, 'ancient.db');
  // 造一个「远古 schema」：连 phash 列都没有（比 P0 还旧——现实中不存在，
  // 用于探测 execDdlTolerant 的吞错边界到底停在哪）。
  // 注意：这里**不**建 idx_phash（建不了）—— 让 AssetStore 自己的 DDL 去撞
  // 「no such column: phash」，从而观察 execDdlTolerant 是否吞掉它。
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE asset (
      id TEXT PRIMARY KEY, rel_path TEXT NOT NULL UNIQUE, base_name TEXT NOT NULL,
      norm_name TEXT NOT NULL, format TEXT NOT NULL, w INTEGER, h INTEGER,
      file_size INTEGER, mtime_ms INTEGER, content_sha256 TEXT NOT NULL,
      grid9_verdict TEXT, grid9_confidence REAL, grid9_evidence TEXT,
      suggested_name TEXT, first_seen_run TEXT, last_seen_run TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_norm ON asset(norm_name);
  `);
  old.close();
  let store = null;
  let openErr = null;
  try {
    store = AssetStore.open({ dbPath, assetRoot: GOLDEN + '/assets' });
  } catch (e) {
    openErr = e;
  }
  ok('P-5a 远古 schema（缺 phash 列）：store 打开不阻断（execDdlTolerant 生效）',
    openErr === null, openErr && openErr.message);
  if (store) {
    // 吞错的副作用：索引静默缺失。验证「只损失性能」的说法。
    const idx = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_phash'").all();
    ok('P-5b 记录：建不成的索引被静默跳过（idx_phash 不存在）= 只损失性能', idx.length === 0,
      JSON.stringify(idx));
    // upsert 全列会抛（缺 phash 等列）—— 即「打开不阻断」≠「任意旧库可用」
    let upsertErr = null;
    try {
      store.upsert({
        id: 'a1', relPath: 'a.png', baseName: 'a', normName: 'a', format: 'png',
        w: 1, h: 1, fileSize: 1, mtimeMs: 1, contentSha256: '0'.repeat(64),
        features: { phash: '0'.repeat(16) }, grid9: null,
        suggestedName: '', firstSeenRun: 'r', lastSeenRun: 'r',
      });
    } catch (e) {
      upsertErr = e;
    }
    ok('P-5c 记录：远古库 upsert 抛「no column named phash」——打开不阻断但用不了',
      upsertErr !== null && /no such column|no column/i.test(upsertErr.message),
      upsertErr && upsertErr.message.slice(0, 80));
    store.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== R2-6. 增量路径其他产物的二次运行稳定性 ===');
{
  const { execFileSync } = require('child_process');
  const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  const runCli = (args) => {
    try {
      execFileSync(NODE, ['--disable-warning=ExperimentalWarning', 'bin/fgui-rb.js', ...args],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status === undefined ? 1 : e.status;
    }
  };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-r2-inc-'));
  const args = ['asset-index', '--root', ROOT, '--assets', path.join(GOLDEN, 'assets'), '--out', d, '--run-id', 'fixed', '--now', '2026-05-13T10:20:30.123Z'];
  runCli(args); // 第 1 次（全新）
  const first = {};
  for (const f of ['map.json', 'contact_sheet.html', 'assets.db']) {
    first[f] = md5(path.join(d, f));
  }
  const metaFirst = JSON.parse(fs.readFileSync(path.join(d, 'run_meta.json'), 'utf8'));
  runCli(args); // 第 2 次（增量缓存）
  for (const f of ['map.json', 'contact_sheet.html']) {
    ok(`增量二次运行 ${f} md5 不变`, md5(path.join(d, f)) === first[f],
      `${first[f]} → ${md5(path.join(d, f))}`);
  }
  // run_meta.json：B9 明确排除（其 _comment 自述「比较范围不含本文件」），
  // 且它**理应**记录本次运行实况 —— 增量二次运行的 indexed/skipped 统计
  // 必然不同（25/0 → 0/25）。这里断言：第 1 次 vs 第 2 次的差异必须
  // **恰为统计字段**，generatedAt 等其余字段必须一致（防时间戳泄漏）。
  {
    const metaSecond = JSON.parse(fs.readFileSync(path.join(d, 'run_meta.json'), 'utf8'));
    const diffKeys = Object.keys(metaFirst)
      .filter((k) => JSON.stringify(metaFirst[k]) !== JSON.stringify(metaSecond[k])).sort();
    ok('增量二次运行 run_meta 差异恰为统计字段（indexed/skipped）',
      JSON.stringify(diffKeys) === JSON.stringify(['indexed', 'skipped']),
      `实际差异键: ${JSON.stringify(diffKeys)}（第1次 indexed=${metaFirst.indexed}/skipped=${metaFirst.skipped}，`
      + `第2次 indexed=${metaSecond.indexed}/skipped=${metaSecond.skipped}）`);
    ok('run_meta.generatedAt 两次一致（--now 注入无泄漏）',
      metaFirst.generatedAt === metaSecond.generatedAt,
      `${metaFirst.generatedAt} vs ${metaSecond.generatedAt}`);
  }
  // assets.db 是二进制缓存，B9 明确不比它；记录其行为（变/不变都记录，不算失败）
  const dbSame = md5(path.join(d, 'assets.db')) === first.assets_db_md5 || md5(path.join(d, 'assets.db')) === first['assets.db'];
  console.log(`  [INFO] assets.db 二次运行 md5：${first['assets.db']} → ${md5(path.join(d, 'assets.db'))}（B9 不比缓存库，记录项）`);
  // 无 .bak/.tmp 残留
  const leftovers = fs.readdirSync(d).filter((f) => f.includes('.bak') || f.endsWith('.tmp'));
  ok('增量二次运行无 .bak/.tmp 残留', leftovers.length === 0, JSON.stringify(leftovers));
  fs.rmSync(d, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== R2-7. 真·P0 旧 schema 库端到端（CLI 级）===');
{
  const { DatabaseSync } = require('node:sqlite');
  const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  const runCli = (args) => {
    try {
      execFileSync(NODE, ['--disable-warning=ExperimentalWarning', 'bin/fgui-rb.js', ...args],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, err: '' };
    } catch (e) {
      return { code: e.status === undefined ? 1 : e.status, err: (e.stderr || '').toString() };
    }
  };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-r2-olddb-'));
  // 手工造 P0 旧 schema 库（无 grid9_suggested_grid 列）放到 out 目录
  const old = new DatabaseSync(path.join(d, 'assets.db'));
  old.exec(`
    CREATE TABLE asset (
      id TEXT PRIMARY KEY, rel_path TEXT NOT NULL UNIQUE, base_name TEXT NOT NULL,
      norm_name TEXT NOT NULL, format TEXT NOT NULL, w INTEGER, h INTEGER,
      file_size INTEGER, mtime_ms INTEGER, content_sha256 TEXT NOT NULL,
      alpha_ratio REAL, alpha_x INTEGER, alpha_y INTEGER, alpha_w INTEGER, alpha_h INTEGER,
      phash TEXT, dominant_r INTEGER, dominant_g INTEGER, dominant_b INTEGER,
      edge_density REAL, corner_solidity REAL, corner_fill REAL,
      mid_row_variance REAL, mid_col_variance REAL, radial_symmetry REAL, aspect_ratio REAL,
      grid9_verdict TEXT, grid9_confidence REAL, grid9_evidence TEXT,
      suggested_name TEXT, first_seen_run TEXT, last_seen_run TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS slot_map (
      slot TEXT PRIMARY KEY, asset_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      confirmed_by TEXT, confirmed_at TEXT
    );`);
  old.close();

  const args = ['asset-index', '--root', ROOT, '--assets', path.join(GOLDEN, 'assets'), '--out', d, '--run-id', 'fixed'];
  const r1 = runCli(args);
  ok('P-7a 旧 schema 库上首次 CLI 运行成功（迁移生效，不报错）', r1.code === 0, r1.err.slice(0, 200));
  const map1 = md5(path.join(d, 'map.json'));
  const r2 = runCli(args);
  ok('P-7b 旧 schema 库上二次 CLI 运行成功', r2.code === 0, r2.err.slice(0, 200));
  const map2 = md5(path.join(d, 'map.json'));

  // 与全新库的 map.json 对比
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-r2-freshdb-'));
  runCli(['asset-index', '--root', ROOT, '--assets', path.join(GOLDEN, 'assets'), '--out', d2, '--run-id', 'fixed']);
  const mapFresh = md5(path.join(d2, 'map.json'));
  ok('P-7c 迁移后二次运行 map.json == 首次', map1 === map2, `${map1} vs ${map2}`);
  ok('P-7d 迁移后 map.json == 全新库运行（迁移无损数据）', map1 === mapFresh, `${map1} vs ${mapFresh}`);
  // suggestedGrid 保留数
  const m = JSON.parse(fs.readFileSync(path.join(d, 'map.json'), 'utf8'));
  const withGrid = m.assets.filter((a) => a.grid9 && a.grid9.suggestedGrid).length;
  ok('P-7e 旧库迁移后 suggestedGrid 保留（>0）', withGrid > 0, `实际 ${withGrid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
}

console.log(`\n=== QA3-round2 汇总: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
