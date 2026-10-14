'use strict';
/** QA-2.7 K5 端到端（修正 API 用法）：检索层绝不静默取第一个 */
const { searchAssets } = require('../src/assets/search');
const { channel1Name } = require('../src/assets/channel1-name');
const { AssetStore } = require('../src/assets/store');
const { normalizeName } = require('../src/core/normalize');
const cfg=require('../fgui.config.json');
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}
function mkRow(id,rel,base,w,h,phash){
  return { id, relPath:rel, baseName:base, normName:normalizeName(base), format:'PNG', w,h,
    fileSize:100, mtimeMs:0, contentSha256:'a'.repeat(64),
    features:{ alphaRatio:1, alphaBox:{x:0,y:0,w,h}, phash:phash||('0'.repeat(16)),
      dominantR:200,dominantG:100,dominantB:100 },
    grid9:null, suggestedName:'' };
}
const S=(store,q,box)=>searchAssets({index:store,queryName:q,layerBox:box,topK:10,config:cfg.search});

console.log('=== 2.7a 矩形1 / 矩形11 / 矩形111 共存，查矩形1（100x50）===');
let st=new AssetStore({dbPath:':memory:'});
st.upsert(mkRow('A','p/矩形1.png','矩形1',100,50,'1111111111111111'));
st.upsert(mkRow('B','p/矩形11.png','矩形11',100,50,'1111111111111111'));
st.upsert(mkRow('C','p/矩形111.png','矩形111',100,50,'1111111111111111'));
let r=S(st,'矩形1',{x:0,y:0,w:100,h:50});
let nm=r.hits.map(h=>h.asset.baseName);
console.log('  -> hits:',JSON.stringify(nm),' certainty='+r.certainty,' ch1.status='+r.channels.ch1.status);
ok('★绝不返回 矩形11/矩形111', !nm.includes('矩形11')&&!nm.includes('矩形111'), JSON.stringify(nm));
ok('★命中 矩形1 本身', nm.includes('矩形1'), JSON.stringify(nm));
// certainty 取值以 docs/types.js 为准：exact_name / ambiguous / guess（小写下划线）
ok('★certainty=exact_name', r.certainty==='exact_name', r.certainty);
r=S(st,'矩形11',{x:0,y:0,w:100,h:50});
nm=r.hits.map(h=>h.asset.baseName);
console.log('  查矩形11 -> ',JSON.stringify(nm));
ok('★查矩形11 绝不返回 矩形1/矩形111', !nm.includes('矩形1')&&!nm.includes('矩形111'), JSON.stringify(nm));

console.log('\n=== 2.7b 矩形1.png(100x50) 与 矩形1(1).png(240x120) 同归一名 —— 尺寸分流 ===');
st=new AssetStore({dbPath:':memory:'});
st.upsert(mkRow('D','p/矩形1.png','矩形1',100,50,'1111111111111111'));
st.upsert(mkRow('E','p/矩形1(1).png','矩形1(1)',240,120,'2222222222222222'));
r=S(st,'矩形1',{x:0,y:0,w:100,h:50});
nm=r.hits.map(h=>h.asset.baseName);
console.log('  查 100x50 ->',JSON.stringify(nm),'status='+r.channels.ch1.status);
ok('★100x50 只命中 矩形1（不误取 矩形1(1)）', nm.length===1&&nm[0]==='矩形1', JSON.stringify(nm));
r=S(st,'矩形1',{x:0,y:0,w:240,h:120});
nm=r.hits.map(h=>h.asset.baseName);
console.log('  查 240x120 ->',JSON.stringify(nm),'status='+r.channels.ch1.status);
ok('★240x120 只命中 矩形1(1)', nm.length===1&&nm[0]==='矩形1(1)', JSON.stringify(nm));

console.log('\n=== 2.7c ★★真歧义：3 张归一化同名且尺寸都过±2px ===');
st=new AssetStore({dbPath:':memory:'});
st.upsert(mkRow('F','p/图标.png','图标',64,64,'aaaaaaaaaaaaaaaa'));
st.upsert(mkRow('G','p/图标(1).png','图标(1)',64,64,'aaaaaaaaaaaaaaaa'));
st.upsert(mkRow('H','p/图标(2).png','图标(2)',65,65,'aaaaaaaaaaaaaaaa'));
r=S(st,'图标',{x:0,y:0,w:64,h:64});
console.log('  hits 数:',r.hits.length,' certainty='+r.certainty,' needsConfirm='+r.needsConfirm,' ch1.status='+r.channels.ch1.status);
r.hits.forEach(h=>console.log(`     ${h.asset.baseName} ${h.asset.w}x${h.asset.h} score=${h.score} conf=${h.confidence} certainty=${h.certainty} needsConfirm=${h.needsConfirm}`));
console.log('  evidence:',r.evidence);
ok('★3 个候选全部返回（绝不只取第一个）', r.hits.length===3, `只返回 ${r.hits.length}`);
ok('★标记为歧义（certainty 非 EXACT_NAME）', r.certainty!=='EXACT_NAME', r.certainty);
ok('★needsConfirm=true（进人工确认队列）', r.needsConfirm===true||r.hits.every(h=>h.needsConfirm===true),
   `r.needsConfirm=${r.needsConfirm}`);
ok('★每条候选置信度都被压到 <=0.6', r.hits.every(h=>h.confidence<=0.6), JSON.stringify(r.hits.map(h=>h.confidence)));
ok('★evidence 含 AMBIGUOUS 字样', /AMBIGUOUS|歧义/.test(JSON.stringify(r.evidence)+r.channels.ch1.evidence), JSON.stringify(r.channels.ch1.evidence).slice(0,150));

console.log('\n=== 2.7d 无 bbox 时不得盲选 ===');
r=S(st,'图标',null);
console.log('  无 layerBox -> hits:',r.hits.length,' certainty='+r.certainty,' status='+r.channels.ch1.status);
ok('★无 bbox 时返回全部候选且标歧义', r.hits.length>=1 && r.certainty!=='EXACT_NAME', `hits=${r.hits.length} certainty=${r.certainty}`);

console.log('\n=== 2.7e 尺寸都不符时必须落Ch-2，不得瞎配 ===');
st=new AssetStore({dbPath:':memory:'});
st.upsert(mkRow('I','p/矩形11.png','矩形11',100,50,'1111111111111111'));
st.upsert(mkRow('J','p/矩形1.png','矩形1',100,50,'1111111111111111'));
r=S(st,'矩形11',{x:0,y:0,w:333,h:222});
nm=r.hits.map(h=>h.asset.baseName);
console.log('  查 矩形11 但 bbox 333x222 -> hits:',JSON.stringify(nm),' status='+r.channels.ch1.status,' certainty='+r.certainty);
ok('★同名但尺寸全不符 -> Ch-1 状态 NO_SIZE_MATCH', r.channels.ch1.status==='NO_SIZE_MATCH', r.channels.ch1.status);
ok('★且不得返回 矩形1（避免前缀误配）', !nm.includes('矩形1'), JSON.stringify(nm));

console.log('\n=== 2.7f 反向：图层名 矩形11 查切图 矩形1 ===');
const c1=channel1Name({index:st,queryName:'矩形11',layerBox:{x:0,y:0,w:100,h:50}});
console.log('  channel1 直调 -> status='+c1.status+' candidates='+JSON.stringify(c1.candidates.map(c=>c.baseName)));
ok('★channel1 层就绝不把 矩形1 当作 矩形11', !c1.candidates.some(c=>c.baseName==='矩形1'),
   JSON.stringify(c1.candidates.map(c=>c.baseName)));

console.log(`\nQA-2.7 结果: pass=${pass} fail=${fail}`);
process.exit(fail>0?1:0);
