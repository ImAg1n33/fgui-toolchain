'use strict';
/** QA 独立验证：K5 命名陷阱 —— 业务最高风险点 */
const { normalizeName, isSameName, sizeWithinTol } = require('../src/core/normalize');
const { AssetStore } = require('../src/assets/store');
const { searchAssets } = require('../src/assets/search');
const fs = require('fs'); const path = require('path'); const os = require('os');

let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log(`  [PASS] ${n}`);} else {fail++;console.log(`  [FAIL] ${n}${e?' :: '+e:''}`);} }

console.log('=== QA-2.1 归一化基本行为（QA 自造，非工程师样本） ===');
const cases = [
  ['矩形1','矩形1',true,'完全同名'],
  ['矩形1','矩形11',false,'★K5 核心陷阱：前缀不同'],
  ['矩形1','矩形111',false,'★K5 核心陷阱：前缀不同'],
  ['矩形11','矩形1',false,'反向'],
  ['矩形1.png','矩形1',true,'去扩展名'],
  ['矩形1(1).png','矩形1',true,'副本后缀 (1)'],
  ['矩形1（1）.png','矩形1',true,'全角副本后缀'],
  ['矩形1[1].png','矩形1',true,'方括号副本后缀'],
  ['矩形1 副本.png','矩形1',true,'中文副本后缀'],
  ['矩形1_copy.png','矩形1',true,'_copy 后缀'],
  ['矩形 1.png','矩形1',true,'去空格'],
  ['矩形　1.png','矩形1',true,'全角空格'],
  ['ＲＥＣＴ１.png','rect1',true,'全角字母'],
  ['图层249(1)','图层249',true,'图层副本'],
  ['ＲＥＣＴ１（１）','rect1',true,'全角全'],
];
for (const [a,b,exp,desc] of cases) {
  const got = isSameName(a,b);
  ok(`${desc}: normalize("${a}")==normalize("${b}") ? ${exp}`, got===exp,
     `normalize a="${normalizeName(a)}" b="${normalizeName(b)}" got=${got}`);
}

console.log('\n=== QA-2.2 归一化幂等性 & 不崩 ===');
const weird = [null, undefined, '', '   ', '.png', '()', '副本', '   矩形1  ', 'a'.repeat(1000)];
let idemFail = 0;
for (const w of weird) {
  const n1 = normalizeName(w);
  const n2 = normalizeName(n1);
  if (n1 !== n2) { idemFail++; console.log(`    非幂等: input=${JSON.stringify(String(w)).slice(0,30)} n1="${n1}" n2="${n2}"`); }
}
ok('归一化幂等 (normalize(normalize(x))===normalize(x))', idemFail===0, `${idemFail} 个输入不幂等`);

console.log('\n=== QA-2.3 空/异常输入返回空串（不得返回 undefined 造成 SQL 误配） ===');
for (const w of [null, undefined, '', '   ']) {
  ok(`normalize(${JSON.stringify(w)}) === ''`, normalizeName(w)==='', `got=${JSON.stringify(normalizeName(w))}`);
}

console.log('\n=== QA-2.4 byNormName 返回类型必须是数组（API 级防御） ===');
const dbPath = path.join(os.tmpdir(), `qa-k5-${Date.now()}.db`);
const store = new AssetStore({ dbPath:':memory:' });
const mk = (id, rel, base, norm, w, h) => ({ id, relPath:rel, baseName:base, normName:norm,
  format:'PNG', w, h, fileSize:1, mtimeMs:0, contentSha256:'x'.repeat(64),
  features:{ alphaRatio:1, alphaBox:{x:0,y:0,w,h}, phash:'0'.repeat(16) }, grid9:null, suggestedName:'' });
// 矩形1 和 矩形11 同时存在
store.upsert(mk('A1','a/矩形1.png','矩形1','矩形1',100,50));
store.upsert(mk('A2','a/矩形11.png','矩形11','矩形11',100,50));
// 矩形1 与 矩形1(1) 归一化后同名（100x50 与 200x80 不同尺寸）
store.upsert(mk('B1','a/矩形1(1).png','矩形1(1)','矩形1',200,80));

const r1 = store.byNormName('矩形1');
ok('byNormName 返回 Array.isArray', Array.isArray(r1), `type=${typeof r1}`);
ok('矩形1 查询返回 2 条（矩形1 + 矩形1(1)），不含 矩形11', r1.length===2,
   `len=${r1.length} names=${JSON.stringify(r1.map(x=>x.baseName))}`);
ok('矩形1 结果不含 矩形11', !r1.some(x=>x.baseName==='矩形11'), JSON.stringify(r1.map(x=>x.baseName)));
const r11 = store.byNormName('矩形11');
ok('矩形11 查询只返回 1 条且是 矩形11', r11.length===1 && r11[0].baseName==='矩形11',
   JSON.stringify(r11.map(x=>x.baseName)));
ok('byNormName([]) 对空串返回空数组', Array.isArray(store.byNormName('')) && store.byNormName('').length===0);
ok('byNormName(null) 返回空数组不崩', Array.isArray(store.byNormName(null)));
ok('byNormName(不存在) 返回空数组', Array.isArray(store.byNormName('不存在图层')));

console.log('\n=== QA-2.5 byNormName 排序稳定性（同尺寸时按 id，乱序插入） ===');
const store2 = new AssetStore({ dbPath:':memory:' });
// 逆序插入，同尺寸
for (const id of ['Z9','M5','A1','B2']) store2.upsert(mk(id,`d/${id}.png`,id,'dup',10,10));
const dupRes = store2.byNormName('dup').map(x=>x.id);
ok('同尺寸同名按 id 升序稳定', JSON.stringify(dupRes)===JSON.stringify(['A1','B2','M5','Z9']), JSON.stringify(dupRes));
// 顺序颠倒再取一次
const dupRes2 = store2.byNormName('dup').map(x=>x.id);
ok('重复查询结果一致（无隐式顺序漂移）', JSON.stringify(dupRes)===JSON.stringify(dupRes2));

console.log('\n=== QA-2.6 全仓库子串匹配漏网扫描 ===');
// 人工审查用：把所有 name/normName 相关比较列出来
const files = [];
(function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const f=path.join(d,e.name);
  if(e.isDirectory()) walk(f); else if(e.name.endsWith('.js')) files.push(f); } })(path.join(__dirname,'..','src'));
const suspicious = [];
for (const f of files) {
  const src = fs.readFileSync(f,'utf8');
  const lines = src.split(/\r?\n/);
  lines.forEach((ln,i)=>{
    // 关注与名称/文件名相关的 startsWith / includes / substring / indexOf / 正则匹配
    if (/\b(startsWith|endsWith|includes|indexOf|substring|substr|match|test|search)\s*\(/.test(ln)
        && /(name|norm|file|base|baseName|relPath|rel_path)/i.test(ln)) {
      suspicious.push(`${path.relative(path.join(__dirname,'..'),f).replace(/\\/g,'/')}:${i+1}  ${ln.trim().slice(0,140)}`);
    }
  });
}
console.log('  --- 需人工判读的名称匹配相关调用 ---');
suspicious.forEach(s=>console.log('   '+s));
store.close(); store2.close();
try{fs.unlinkSync(dbPath);}catch{}

console.log(`\nQA-2 结果: pass=${pass} fail=${fail}  (可疑点 ${suspicious.length} 处待人工判读)`);
process.exit(fail>0?1:0);
