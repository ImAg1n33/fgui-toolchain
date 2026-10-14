'use strict';
/** QA-5 九宫格三档判定：自己造不同于工程师的形态，重点找误判 */
const fs=require('fs'),path=require('path'),os=require('os');
const sharp=require('sharp');
const { computeGrid9 } = require('../src/imaging/grid9');
const { extractFeatures } = require('../src/imaging/features');
const { createDecoder } = require('../src/imaging/decoder');
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'..','fgui.config.json'),'utf8'));
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`    [PASS] ${n}`);}else{fail++;console.log(`    [FAIL] ${n}${e?':: '+e:''}`);}}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa-g9-'));

/** 生成 RGBA Buffer */
function rgba(w,h,fn){const b=Buffer.alloc(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const[r,g,bl,a]=fn(x,y);const i=(y*w+x)*4;
    b[i]=r;b[i+1]=g;b[i+2]=bl;b[i+3]=a;}return b;}
async function save(name,w,h,fn){
  const p=path.join(tmp,name+'.png');
  await sharp(rgba(w,h,fn),{raw:{width:w,height:h,channels:4}}).png().toFile(p);
  return p;
}
/** 判定 */
const dec=createDecoder();
async function judge(p){
  const px=await dec.decodeToRgba(p);
  const f=extractFeatures(px);
  const g=computeGrid9(f,{...cfg.grid9});
  return {f,g};
}

(async()=>{
console.log('=== QA-5.1 面板类（期望 CAN_9GRID）===');
const panels=[
  ['纯色面板 120x80', async()=>await save('p_panel',120,80,()=>[200,60,60,255]),'CAN_9GRID'],
  ['小圆角面板 120x80 r=6', async()=>await save('p_r6',120,80,(x,y)=>{
      const r=6; const dx=Math.min(x,119-x), dy=Math.min(y,79-y);
      const inCorner=(x<r&&y<r)||(x>=120-r&&y<r)||(x<r&&y>=80-r)||(x>=120-r&&y>=80-r);
      if(inCorner){const cx=x<r?r-1:120-r, cy=y<r?r-1:80-r; if((x-cx)**2+(y-cy)**2>r*r)return[0,0,0,0];}
      return[200,60,60,255];}),'CAN_9GRID'],
  ['带边框面板（有描边）', async()=>await save('p_bd',100,60,(x,y)=>{
      const edge=(x<2||x>=98||y<2||y>=58);return edge?[40,40,40,255]:[210,180,120,255];}),'CAN_9GRID'],
  ['横向渐变面板（左暗右亮）', async()=>await save('p_grad',160,50,(x,y)=>{
      const t=x/159;return[Math.round(60+180*t),Math.round(60+120*t),Math.round(200-100*t),255];}),'CAN_9GRID'],
  ['竖向渐变面板', async()=>await save('p_gradv',60,140,(x,y)=>{
      const t=y/139;return[Math.round(60+180*t),Math.round(60+120*t),Math.round(200-100*t),255];}),'CAN_9GRID'],
];
for(const [name,mk,exp] of panels){
  const p=await mk(); const {f,g}=await judge(p);
  const key=`cornerFill=${f.cornerFill.toFixed(3)} radial=${f.radialSymmetry.toFixed(3)} midColVar=${f.midColVariance.toFixed(3)} midRowVar=${f.midRowVariance.toFixed(3)} aspect=${(f.aspectRatio||0).toFixed(2)}`;
  console.log(`  ${name.padEnd(26)} => ${g.verdict.padEnd(16)} conf=${g.confidence} [${key}]`);
  ok(`${name} -> ${exp}`, g.verdict===exp, `实得${g.verdict}`);
}

console.log('\n=== QA-5.2 胶囊类（期望 SINGLE_AXIS_ONLY）===');
function capsuleImg(w,h,rad){
  return (x,y)=>{
    const cx=Math.min(x,w-1-x), cy=Math.min(y,h-1-y);
    const rx=Math.min(cx,rad), ry=Math.min(cy,rad);
    if(rx<rad&&ry<rad){ if((rad-rx)**2+(rad-ry)**2>rad*rad) return[0,0,0,0]; }
    return[220,80,80,255];};
}
const caps=[
  ['胶囊 160x40 r=20',160,40,20],
  ['胶囊 240x40 r=20（宽）',240,40,20],
  ['胶囊 300x36 r=18（更宽）',300,36,18],
  ['胶囊 100x44 r=22（近圆）',100,44,22],
];
for(const [name,w,h,rad] of caps){
  const p=await save('c_'+w+'_'+h+'_'+rad,w,h,capsuleImg(w,h,rad));
  const {f,g}=await judge(p);
  console.log(`  ${name.padEnd(26)} => ${g.verdict.padEnd(16)} conf=${g.confidence} [cornerFill=${f.cornerFill.toFixed(3)} radial=${f.radialSymmetry.toFixed(3)} aspect=${(f.aspectRatio||0).toFixed(2)}] grid=${g.suggestedGrid||'-'}`);
  ok(`${name} -> SINGLE_AXIS_ONLY`, g.verdict==='SINGLE_AXIS_ONLY', `实得${g.verdict}`);
}

console.log('\n=== QA-5.3 圆形/菱形（期望 NEVER）===');
const rounds=[
  ['正圆 100x100 r=50',100,100,(x,y)=>{const dx=x-49.5,dy=y-49.5;return dx*dx+dy*dy<=2500?[250,200,50,255]:[0,0,0,0];}],
  ['圆 64x64',64,64,(x,y)=>{const dx=x-31.5,dy=y-31.5;return dx*dx+dy*dy<=1024?[80,180,250,255]:[0,0,0,0];}],
  ['菱形 100x100',100,100,(x,y)=>{return (Math.abs(x-49.5)+Math.abs(y-49.5))<=50?[180,80,220,255]:[0,0,0,0];}],
  ['椭圆 160x80',160,80,(x,y)=>{const dx=(x-79.5)/80,dy=(y-39.5)/40;return dx*dx+dy*dy<=1?[240,120,60,255]:[0,0,0,0];}],
  ['星形',100,100,(x,y)=>{const a=Math.atan2(y-49.5,x-49.5),r=Math.hypot(x-49.5,y-49.5);
      const rr=30+12*Math.sin(a*5); return r<=rr?[255,220,80,255]:[0,0,0,0];}],
];
for(const [name,w,h,fn] of rounds){
  const p=await save('r_'+name.replace(/[^\w]/g,''),w,h,fn);
  const {f,g}=await judge(p);
  console.log(`  ${name.padEnd(26)} => ${g.verdict.padEnd(16)} conf=${g.confidence} [cornerFill=${f.cornerFill.toFixed(3)} radial=${f.radialSymmetry.toFixed(3)} midColVar=${f.midColVariance.toFixed(3)} aspect=${(f.aspectRatio||0).toFixed(2)}]`);
  ok(`${name} -> NEVER`, g.verdict==='NEVER', `实得${g.verdict}`);
}

console.log('\n=== QA-5.4 ★误判探测：放射状纹理 / 对角线纹理 / 渐变（重点）===');
const tricky=[
  ['放射状条纹 120x120（8 辐）',120,120,(x,y)=>{
     const a=Math.atan2(y-59.5,x-59.5); const v=Math.sin(a*8)>0?255:20;
     return[v,v,v,255];},'NEVER'],
  ['放射状条纹 120x120（16 辐）',120,120,(x,y)=>{
     const a=Math.atan2(y-59.5,x-59.5); const v=Math.sin(a*16)>0?255:20;
     return[v,v,v,255];},'NEVER'],
  ['放射状渐变（平滑，非条纹）',120,120,(x,y)=>{
     const a=Math.atan2(y-59.5,x-59.5); const v=Math.round(128+120*Math.cos(a));
     return[v,v,v,255];},'NEVER'],
  ['对角线纹理 120x120',120,120,(x,y)=>{const v=((x+y)%16<8)?230:40;return[v,v,v,255];},'NEVER'],
  ['对角线渐变（平滑）',120,120,(x,y)=>{const t=(x+y)/238;return[Math.round(255*t),Math.round(128+100*t),255,255];},'CAN_9GRID'],
  ['棋盘格 120x120',120,120,(x,y)=>{const v=((Math.floor(x/12)+Math.floor(y/12))%2)?240:30;return[v,v,v,255];},'NEVER'],
  ['横向条纹 120x40',120,40,(x,y)=>{const v=(Math.floor(y/5)%2)?230:40;return[v,v,v,255];},'NEVER'],
  ['竖向条纹 40x120',40,120,(x,y)=>{const v=(Math.floor(x/5)%2)?230:40;return[v,v,v,255];},'NEVER'],
];
for(const [name,w,h,fn,exp] of tricky){
  const p=await save('t_'+name.replace(/[^\w]/g,''),w,h,fn);
  const {f,g}=await judge(p);
  console.log(`  ${name.padEnd(30)} => ${g.verdict.padEnd(16)} [cornerFill=${f.cornerFill.toFixed(3)} radial=${f.radialSymmetry.toFixed(3)} midRowVar=${f.midRowVariance.toFixed(3)} midColVar=${f.midColVariance.toFixed(3)}] 期望${exp}`);
  ok(`${name} -> ${exp}`, g.verdict===exp, `实得${g.verdict}`);
}

console.log('\n=== QA-5.5 ★「不确定返 NEVER」哲学是否真的贯彻 ===');
// 空白/全透明图：任何特征都无意义，必须 NEVER
const odd=[
  ['全透明 100x100',100,100,()=>[0,0,0,0]],
  ['1x1 白',1,1,()=>[255,255,255,255]],
  ['2x2 棋盘',2,2,(x,y)=>((x+y)%2)?[255,255,255,255]:[0,0,0,255]],
  ['极小 8x8 纯色',8,8,()=>[128,128,128,255]],
  ['单行 200x1',200,1,(x)=>[x*255/199|0,0,0,255]],
  ['单列 1x200',1,200,(x,y)=>[0,y*255/199|0,0,255]],
];
for(const [name,w,h,fn] of odd){
  const p=await save('o_'+name.replace(/[^\w]/g,''),w,h,fn);
  const {f,g}=await judge(p);
  console.log(`  ${name.padEnd(20)} => ${g.verdict.padEnd(16)} conf=${g.confidence} [aR=${(f.alphaRatio||0).toFixed(3)} cornerFill=${(f.cornerFill||0).toFixed(3)}]`);
  ok(`${name} -> NEVER（不确定就放弃）`, g.verdict==='NEVER', `实得${g.verdict}`);
}

console.log('\n=== QA-5.6 阈值是否真的外置（改配置不改代码）===');
// 用极端阈值跑同一张面板图，验证判定随配置变
const p=await save('cfg_panel',120,80,()=>[200,60,60,255]);
const px=await dec.decodeToRgba(p); const f=extractFeatures(px);
const base=computeGrid9(f,{...cfg.grid9});
const neverCfg=computeGrid9(f,{...cfg.grid9,cornerFillPanelMin:0.999});
console.log(`  默认阈值 -> ${base.verdict}；cornerFillPanelMin=0.999 -> ${neverCfg.verdict}`);
ok('★改配置即可改变判定（阈值真外置）', base.verdict!==neverCfg.verdict || neverCfg.verdict==='NEVER',
   `两者均${base.verdict}`);
// 确认代码里没有硬编码阈值
const g9src=fs.readFileSync(path.join(__dirname,'..','src','imaging','grid9.js'),'utf8');
const featsrc=fs.readFileSync(path.join(__dirname,'..','src','imaging','features.js'),'utf8');
const hardcoded=[...g9src.matchAll(/cornerFill\s*[<>]=?\s*0\.\d+|radialSymmetry\s*[<>]=?\s*0\.\d+|Variance\s*[<>]=?\s*0\.\d+/g)].map(m=>m[0]);
ok('grid9.js 内无硬编码阈值字面量', hardcoded.length===0, JSON.stringify(hardcoded));
// ★ 排除 _comment 等说明键（它们是给人读的注释，不是阈值）
const cfgKeys=Object.keys(cfg.grid9).filter(k=>!k.startsWith('_'));
const dflt=(()=>{const m=g9src.match(/DEFAULT_THRESHOLDS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  return m?[...m[1].matchAll(/(\w+)\s*:/g)].map(x=>x[1]):[];})();
const missing=cfgKeys.filter(k=>!dflt.includes(k));
const extra=dflt.filter(k=>!cfgKeys.includes(k));
ok('配置键与代码默认键完全一致（坑15 守卫）', missing.length===0&&extra.length===0, `配置有代码无=${JSON.stringify(missing)} 代码有配置无=${JSON.stringify(extra)}`);
// 数值一致性
const numMis=[];
for(const k of cfgKeys){
  const m=g9src.match(new RegExp(`${k}\\s*:\\s*([\\d.]+)`));
  if(m&&cfg.grid9[k]!==undefined&&Number(m[1])!==Number(cfg.grid9[k])) numMis.push(`${k}: 配置${cfg.grid9[k]} vs 代码${m[1]}`);
}
ok('配置数值与代码默认值逐项一致', numMis.length===0, JSON.stringify(numMis));

console.log(`\nQA-5 结果: pass=${pass} fail=${fail}`);
fs.rmSync(tmp,{recursive:true,force:true});
process.exit(fail>0?1:0);
})();
