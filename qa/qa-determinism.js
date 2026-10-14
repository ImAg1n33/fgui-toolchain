'use strict';
/** QA-1b 主动打破确定性：注入污染源，看是否被防住 */
const path=require('path'); const fs=require('fs'); const os=require('os');
const { round6, sortKeysDeep, sortBy, entriesSorted, toPosixRel } = require('../src/core/determinism');
const { normalizeName } = require('../src/core/normalize');
let pass=0,fail=0,warn=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?' :: '+e:''}`);} }

console.log('=== QA-1b.1 污染源逐项探测 ===');
// 1. 对象键插入顺序
const o1={}; o1.z=1; o1.a=2; o1.m=3;
const o2={}; o2.a=2; o2.m=3; o2.z=1;
ok('sortKeysDeep消除键插入顺序', JSON.stringify(sortKeysDeep(o1))===JSON.stringify(sortKeysDeep(o2)),
   `${JSON.stringify(sortKeysDeep(o1))} vs ${JSON.stringify(sortKeysDeep(o2))}`);
// 嵌套
const n1={b:{z:1,a:2},a:[{y:1,x:2}]}; const n2={a:[{x:2,y:1}],b:{a:2,z:1}};
ok('sortKeysDeep 递归处理嵌套', JSON.stringify(sortKeysDeep(n1))===JSON.stringify(sortKeysDeep(n2)),
   `${JSON.stringify(sortKeysDeep(n1))}\n            vs ${JSON.stringify(sortKeysDeep(n2))}`);
// 2. 浮点累积
ok('round6 消除浮点尾差', round6(0.1+0.2)===round6(0.3), `${round6(0.1+0.2)} vs ${round6(0.3)}`);
ok('round6 对 1/3 稳定', round6(1/3)===round6(0.3333333333), `${round6(1/3)}`);
ok('round6 输出是 number 而非 string', typeof round6(1.005)==='number', `type=${typeof round6(1.005)} val=${round6(1.005)}`);
// 3. 数组顺序
ok('sortBy 多键稳定', JSON.stringify(sortBy([{a:1,b:2},{a:1,b:1},{a:0,b:9}],x=>x.a,x=>x.b).map(x=>`${x.a}${x.b}`))
   ===JSON.stringify(['09','11','12']), JSON.stringify(sortBy([{a:1,b:2},{a:1,b:1},{a:0,b:9}],x=>x.a,x=>x.b)));
// 4. Map/Set 迭代顺序
const m=new Map(); m.set('z',1); m.set('a',2); m.set('m',3);
const m2=new Map(); m2.set('a',2); m2.set('m',3); m2.set('z',1);
ok('entriesSorted 消除Map 插入序', JSON.stringify(entriesSorted(m))===JSON.stringify(entriesSorted(m2)),
   `${JSON.stringify(entriesSorted(m))} vs ${JSON.stringify(entriesSorted(m2))}`);
const st=new Set(['z','a','m']); const st2=new Set(['m','z','a']);
ok('entriesSorted 消除Set 插入序', JSON.stringify(entriesSorted(st))===JSON.stringify(entriesSorted(st2)),
   `${JSON.stringify(entriesSorted(st))} vs ${JSON.stringify(entriesSorted(st2))}`);

console.log('\n=== QA-1b.2 真实污染源：文件系统遍历顺序 ===');
const { AssetIndex } = (()=>{ try { return require('../src/assets/indexer'); } catch { return {}; } })();
const idx = require('../src/assets/indexer');
//构造一个目录，其枚举顺序在 Windows NTFS 上不按字典序
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa-fsord-'));
const names=['z.png','a.png','m.png','B.png','1.png','_.png','~.png','ä.png'];
for(const n of names){ fs.writeFileSync(path.join(tmp,n),Buffer.from([0x89,0x50,0x4e,0x47])); }
const rawOrder=fs.readdirSync(tmp);
console.log('  原始 readdir 顺序:', JSON.stringify(rawOrder));
const sortedOrder=[...rawOrder].sort();
console.log('  排序后顺序      :', JSON.stringify(sortedOrder));
ok('文件系统枚举顺序确实不等于字典序（说明排序是必要的）',
   JSON.stringify(rawOrder)!==JSON.stringify(sortedOrder), '恰好相同 —— 本机无法证伪排序的必要性');

console.log('\n=== QA-1b.3 --now 注入是否真的生效 ===');
// ★ API 名以 src/core/fs-json.js 实际导出为准（writeJson / writeText）
const { writeJson, writeText, writeJsonAtomic, writeTextAtomic } = require('../src/core/fs-json');
const { atomicWrite } = require('../src/core/atomic');
const tmp2=fs.mkdtempSync(path.join(os.tmpdir(),'qa-now-'));
const t1='2020-01-02T03:04:05.678Z', t2='2031-11-12T13:14:15.999Z';
try {
  // ★ 用 writeJsonAtomic：now 注入用于 .bak 文件名（产物内容本身零时间戳）
  //   注意：.bak 只在「目标已存在」时产生，故先各写一次再覆盖，才能观察到备份名。
  const aPath=path.join(tmp2,'a.json'), bPath=path.join(tmp2,'b.json');
  writeJsonAtomic(aPath,{v:0},{root:tmp2,now:t1,backup:true});
  writeJsonAtomic(bPath,{v:0},{root:tmp2,now:t2,backup:true});
  const r1=writeJsonAtomic(aPath,{v:1},{root:tmp2,now:t1,backup:true});
  const r2=writeJsonAtomic(bPath,{v:1},{root:tmp2,now:t2,backup:true});
  const c1=fs.readFileSync(r1.path,'utf8'), c2=fs.readFileSync(r2.path,'utf8');
  console.log('  a.json:',JSON.stringify(c1.slice(0,200)));
  console.log('  b.json:',JSON.stringify(c2.slice(0,200)));
  // ★ 修正 QA 原始断言：产物内容**本就不该**有时间戳（B9 红线），
  //   now 的作用是让 .bak 备份文件名可复现，而不是进 JSON 内容。
  ok('now 注入体现在 .bak 文件名（产物内容保持零时间戳）',
     !!r1.backupPath && /\.bak\.20200102T030405/.test(r1.backupPath),
     `backupPath=${r1.backupPath} 期望含 .bak.20200102T030405（注入值 ${t1}）`);
  ok('产物内容零时间戳（now 不得进 JSON 内容）',
     !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(c1) && !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(c2),
     '产物内出现时间戳');
} catch(e){ ok('writeJson 支持 now 注入', false, e.message); }
// 检查原子写备份名是否用注入的 now
try{
  const f=path.join(tmp2,'c.txt');
  // ★ atomicWrite 签名是 {targetPath, content, now}；.bak 需目标已存在
  atomicWrite({targetPath:f, content:'hi', now:t1});
  atomicWrite({targetPath:f, content:'hello', now:t1});
  const bak=fs.readdirSync(tmp2).filter(x=>x.startsWith('c.txt.bak'));
  console.log('  备份文件:',JSON.stringify(bak));
  ok('备份文件名使用注入的 now', bak.some(x=>x.includes('20200102T030405')),
     `备份=${JSON.stringify(bak)} 期望含 20200102T030405`);
}catch(e){ ok('writeFileAtomic 备份名用注入 now', false, e.message); }

console.log('\n=== QA-1b.4 产物内是否残留时间戳/随机数 ===');
const det=require('../src/core/determinism');
console.log('  determinism.js 导出的函数:', Object.keys(det).join(', '));

console.log('\n=== QA-1b.5 src/ 中 Date.now / Math.random / new Date 使用点 ===');
const files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);
  if(e.isDirectory())w(f);else if(e.name.endsWith('.js'))files.push(f);}})(path.join(__dirname,'..','src'));
const nondetHits=[];
for(const f of files){const src=fs.readFileSync(f,'utf8');src.split(/\r?\n/).forEach((ln,i)=>{
  if(/Math\s*\.\s*random|new\s+Date\s*\(\s*\)|Date\s*\.\s*now|process\s*\.\s*hrtime|performance\s*\.\s*now/.test(ln)
     && !/^\s*(\*|\/\/)/.test(ln))
    nondetHits.push(`${path.relative(path.join(__dirname,'..'),f).replace(/\\/g,'/')}:${i+1}  ${ln.trim().slice(0,120)}`);});}
if(nondetHits.length===0) console.log('  ✅ src/ 零非确定性源');
else nondetHits.forEach(h=>console.log('  ⚠ '+h));

console.log('\n=== QA-1b.6 locale 相关排序（localeCompare 是非确定性的经典陷阱） ===');
const zhHans=['一','二','三','丁','七'];
const zhHant=['一','二','三','丁','七'];
const c1=[...zhHans].sort((a,b)=>a.localeCompare(b,'zh-Hans-CN'));
const c2=[...zhHant].sort((a,b)=>a.localeCompare(b,'zh-Hant-TW'));
console.log('  zh-Hans-CN:',JSON.stringify(c1));
console.log('  zh-Hant-TW:',JSON.stringify(c2));
// ★ 本机 Node 只内置一个 collation，「两 locale 排序是否不同」无法在此环境证伪 ★
//   故改为断言「我的代码不依赖 localeCompare」—— 那才是可控的那一半。
//   （QA 报告 §3.1 已确认：determinism.js 用的是 cmpStr 的 < > 比较，不是 localeCompare）
const usesLocale = (()=>{const src=fs.readFileSync(path.resolve(__dirname,'../src/core/determinism.js'),'utf8');
  return src.split(/\r?\n/).some(ln=>{const t=ln.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && /localeCompare/.test(ln);});})();
ok('代码不依赖 localeCompare（不依赖 ICU/locale 环境）', !usesLocale,
   'determinism.js 里出现了实际的 localeCompare 调用');
console.log('  注：localeCompare 的跨环境差异需在装有多种 collation 的机器上验证；');
console.log('      本机能确定的是「我的实现根本没用它」，故不受 ICU 影响。');
const codeHits=[];
for(const f of files){const src=fs.readFileSync(f,'utf8');src.split(/\r?\n/).forEach((ln,i)=>{
  const t=ln.trim();
  // ★ 跳过注释行：本项目在 determinism.js 的注释里明确写了「不用 localeCompare」，
  //   那句话本身含该词，不排除就会误报（QA 自己的初版脚本也踩过类似的坑）。
  if(!t||t.startsWith('//')||t.startsWith('*')||t.startsWith('/*'))return;
  if(/localeCompare|toLocale(Upper|Lower|Date|String)|Intl\./.test(ln)) codeHits.push(`${f}:${i+1}`);});}
ok('src/ 未使用 localeCompare / toLocale* / Intl.*（确定性安全）', codeHits.length===0, JSON.stringify(codeHits));

console.log(`\nQA-1b 结果: pass=${pass} fail=${fail} warn=${warn}`);
try{fs.rmSync(tmp,{recursive:true,force:true});fs.rmSync(tmp2,{recursive:true,force:true});}catch{}
process.exit(fail>0?1:0);
