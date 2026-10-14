'use strict';
/**
 * qa-p1a/qa3-config-guard.js —— QA 第三轮：配置驱动与守卫有效性验证
 *
 * P0「坑15 守卫」的同类问题：守卫断言的是**原始配置文件**还是**合并后对象**？
 * 若是合并后对象，删键会被默认值补回 → 断言恒真 → 守卫失效。
 *
 * 1. 静态确认守卫用 readRawConfig（原始文件）
 * 2. 变异 A：fgui.config.json 删一个键 → 守卫测试必须红
 * 3. 变异 B：fgui.config.json 改一个值 → 守卫测试必须红
 * 4. 变异 C：fgui.config.json 把键改名 → 守卫测试必须红
 * 5. 变异 D：constants.js 的 DEFAULT_FGUI_CONFIG 改值 → 守卫测试必须红
 * 6. 端到端：loadConfig 真实加载改过的配置 → lint 行为随之改变
 *    （证明「配置驱动」不是单元级自嗨，而是贯穿 loadConfig 的）
 *
 * 运行：node qa-p1a/qa3-config-guard.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'fgui.config.json');
const CONSTANTS = path.join(ROOT, 'src/fgui/constants.js');
const GUARD_TEST = 'test/unit/lint-rules.test.js';
const NODE = 'C:/Program Files/nodejs/node.exe';

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

function runGuardTest() {
  try {
    execFileSync(NODE, ['--disable-warning=ExperimentalWarning', '--test', GUARD_TEST],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status || 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

console.log('=== QA3-C1. 静态确认：守卫断言原始配置文件而非合并后对象 ===');
{
  const testSrc = fs.readFileSync(path.join(ROOT, GUARD_TEST), 'utf8');
  ok('守卫测试引用 readRawConfig（原始文件）', /readRawConfig\(/.test(testSrc));
  ok('守卫测试读取 fgui.config.json 路径', /fgui\.config\.json/.test(testSrc));
  ok('守卫测试同时断言 DEFAULT_FGUI_CONFIG 与 core 默认', /DEFAULT_FGUI_CONFIG/.test(testSrc) && /defaultConfig\(\)\.fgui/.test(testSrc));
  // 反向：守卫不应使用 loadConfig 的合并结果做对账
  const guardBlock = testSrc.slice(testSrc.indexOf('配置守卫'));
  ok('守卫不用 loadConfig 合并结果对账（防自证循环）', !/loadConfig\(.*\)\.config/.test(guardBlock));
}

console.log('\n=== QA3-C2. 基线：未变异时守卫测试全绿 ===');
{
  const r = runGuardTest();
  ok('守卫测试基线全绿', r.code === 0, r.out.slice(-300));
}

console.log('\n=== QA3-C3. 变异 A/B/C：改 fgui.config.json，守卫必须红 ===');
{
  const original = fs.readFileSync(CONFIG, 'utf8');
  const mutations = [
    {
      name: 'A 删键（删除 maxObjectsPerComponent）',
      apply: (s) => s.replace(/\s*"maxObjectsPerComponent": 80,/, ''),
    },
    {
      name: 'B 改值（pkgIdLength 8 → 6）',
      apply: (s) => s.replace('"pkgIdLength": 8', '"pkgIdLength": 6'),
    },
    {
      name: 'C 键改名（idDigits → idDigitCount）',
      apply: (s) => s.replace('"idDigits": 5', '"idDigitCount": 5'),
    },
  ];
  try {
    for (const m of mutations) {
      const mutated = m.apply(original);
      if (mutated === original) {
        ok(`${m.name}（变异未生效，跳过）`, false, '替换未改变文件');
        continue;
      }
      fs.writeFileSync(CONFIG, mutated, 'utf8');
      const r = runGuardTest();
      ok(`${m.name} → 守卫测试变红`, r.code !== 0, `exit=${r.code}（仍绿 → 守卫失效）`);
      // 错误信息应点名不一致的键
      ok(`${m.name} → 失败信息可读（含键名/不一致）`,
        /不一致|fgui\./.test(r.out), r.out.slice(-200));
      fs.writeFileSync(CONFIG, original, 'utf8');
      const r2 = runGuardTest();
      ok(`${m.name} → 恢复后守卫重新全绿`, r2.code === 0);
    }
  } finally {
    fs.writeFileSync(CONFIG, original, 'utf8');
  }
  ok('★ fgui.config.json 已还原', fs.readFileSync(CONFIG, 'utf8') === original);
}

console.log('\n=== QA3-C4. 变异 D：改 constants.js 默认值，守卫必须红 ===');
{
  const original = fs.readFileSync(CONSTANTS, 'utf8');
  try {
    const mutated = original.replace('maxObjectsPerComponent: 80,', 'maxObjectsPerComponent: 81,');
    if (mutated === original) {
      ok('D 改 constants 默认值（变异未生效）', false, '锚点未找到');
    } else {
      fs.writeFileSync(CONSTANTS, mutated, 'utf8');
      const r = runGuardTest();
      ok('D 改 constants.js 的 maxObjectsPerComponent → 守卫测试变红', r.code !== 0, `exit=${r.code}`);
      fs.writeFileSync(CONSTANTS, original, 'utf8');
      const r2 = runGuardTest();
      ok('D → 恢复后守卫重新全绿', r2.code === 0);
    }
  } finally {
    fs.writeFileSync(CONSTANTS, original, 'utf8');
  }
  ok('★ constants.js 已还原', fs.readFileSync(CONSTANTS, 'utf8') === original);
}

console.log('\n=== QA3-C5. 端到端：loadConfig 加载改过的配置真的改变 lint 行为 ===');
{
  const { loadConfig } = require('../src/core/config');
  const { lintComponentXml } = require('../src/fgui/lint-rules');

  const XML_WITH_FOO = '<?xml version="1.0"?>\n<component exported="true">\n  <displayList>\n    <foo id="b00001" name="qa_foo" xy="0,0" size="10,10"/>\n  </displayList>\n</component>\n';

  // 写一份临时配置：displayListTags 放行 foo
  const tmpCfg = path.join(ROOT, 'fgui.config.qa3tmp.json');
  const cfgObj = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfgObj.fgui.displayListTags = [...cfgObj.fgui.displayListTags, 'foo'];
  fs.writeFileSync(tmpCfg, JSON.stringify(cfgObj, null, 2));
  try {
    // 默认配置：必须报 R-01
    const def = loadConfig({ configPath: tmpCfg.replace('fgui.config.qa3tmp', 'nonexistent') });
    const rDefault = lintComponentXml(XML_WITH_FOO, { config: def.config });
    ok('默认配置下 <foo> 报 R-01', rDefault.errors.some((e) => e.rule === 'R-01'),
      JSON.stringify(rDefault.errors.map((e) => e.rule)));

    // 放行 foo 的配置：不报 R-01（端到端走 loadConfig 真实路径）
    const relaxed = loadConfig({ configPath: tmpCfg });
    ok('loadConfig 真的读到了放行配置', relaxed.config.fgui.displayListTags.includes('foo'));
    const rRelaxed = lintComponentXml(XML_WITH_FOO, { config: relaxed.config });
    ok('放行配置下 <foo> 不报 R-01（配置驱动端到端生效）',
      !rRelaxed.errors.some((e) => e.rule === 'R-01'),
      JSON.stringify(rRelaxed.errors.map((e) => `${e.rule}:${e.message.slice(0, 30)}`)));

    // 再验一条：colorRequireAlpha=true 的端到端
    cfgObj.fgui.colorRequireAlpha = true;
    fs.writeFileSync(tmpCfg, JSON.stringify(cfgObj, null, 2));
    const strict = loadConfig({ configPath: tmpCfg });
    const xmlNoAlpha = '<?xml version="1.0"?>\n<component exported="true">\n  <displayList>\n    <text id="b00001" name="qa_t" xy="0,0" size="10,10" color="#112233"/>\n  </displayList>\n</component>\n';
    const rStrict = lintComponentXml(xmlNoAlpha, { config: strict.config });
    ok('colorRequireAlpha=true 端到端生效（省略 alpha 开始报错）',
      rStrict.errors.some((e) => e.rule === 'R-03' && e.message.includes('alpha')));
  } finally {
    if (fs.existsSync(tmpCfg)) fs.unlinkSync(tmpCfg);
  }
}

console.log(`\n=== QA3-config 汇总: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
