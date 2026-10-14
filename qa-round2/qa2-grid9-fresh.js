'use strict';
/** 第二轮 · 九宫格独立复测：全部用我自己造的形态 + 评估危险侧的 3 类 */
const fs=require('fs'),path=require('path'),os=require('os');
const sharp=require('sharp');
const { computeGrid9, VERDICT } = require('../src/imaging/grid9');
const { extractFeatures } = require('../src/imaging/features');
const { createDecoder } = require('../src/imaging/decoder');
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'..','fgui.config.json'),'utf8'));
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`    [PASS] ${n}`);}else{fail++;console.log(`    [FAIL] ${n}${e?':: '+e:''}`);}}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa2-g9-'));
function rgba(w,h,fn){const b=Buffer.alloc(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const[r,g,bl,a]=fn(x,y);const i=(y*w+x)*4;b[i]=r;b[i+1]=g;b[i+2]=bl;b[i+3]=a;}return b;}
const dec=createDecoder();
async function judge(name,w,h,fn){
  const p=path.join(tmp,name.replace(/[^\w]/g,'')+'.png');
  await sharp(rgba(w,h,fn),{raw:{width:w,height:h,channels:4}}).png().toFile(p);
  const px=await dec.decodeToRgba(p);
  const f=extractFeatures(px);
  const g=computeGrid9(f,{...cfg.grid9});
  return {f,g};
}
function capsule(w,h,rad){return (x,y)=>{const cx=Math.min(x,w-1-x),cy=Math.min(y,h-1-y);
  const rx=Math.min(cx,rad),ry=Math.min(cy,rad);
  if(rx<rad&&ry<rad){if((rad-rx)**2+(rad-ry)**2>rad*rad)return[0,0,0,0];}
  return[220,80,80,255];};}

(async()=>{
console.log('=== R2-5.1 我第一轮报的 4 类误判，现在用【我自己新造的】同类样本复测 ===');
const fixes=[
  // [名称, w, h, 生成器, 期望]
  ['渐变面板 横 200x60（第一轮同类）',200,60,(x,y)=>{const t=x/199;return[Math.round(40+190*t),Math.round(60+140*t),Math.round(210-120*t),255];},'CAN_9GRID'],
  ['渐变面板 竖 70x180',70,180,(x,y)=>{const t=y/179;return[Math.round(40+190*t),Math.round(60+140*t),Math.round(210-120*t),255];},'CAN_9GRID'],
  ['渐变面板 对角 150x150',150,150,(x,y)=>{const t=(x+y)/298;return[Math.round(60+180*t),Math.round(90+120*t),Math.round(220-100*t),255];},'CAN_9GRID'],
  ['描边面板 2px 描边 140x90',140,90,(x,y)=>{const e=x<2||x>=138||y<2||y>=88;return e?[35,35,45,255]:[215,190,130,255];},'CAN_9GRID'],
  ['描边面板 4px 描边 140x90',140,90,(x,y)=>{const e=x<4||x>=136||y<4||y>=86;return e?[35,35,45,255]:[215,190,130,255];},'CAN_9GRID'],
  ['描边面板 8px 粗描边 140x90',140,90,(x,y)=>{const e=x<8||x>=132||y<8||y>=82;return e?[35,35,45,255]:[215,190,130,255];},'CAN_9GRID'],
  ['浮雕按钮 上下高光 120x50',120,50,(x,y)=>{if(y<5)return[255,235,190,255]; if(y>=45)return[110,70,25,255]; return[225,160,70,255];},'CAN_9GRID'],
  ['内阴影+渐变 160x70',160,70,(x,y)=>{const e=(x<3||x>=157||y<3||y>=67);
    if(e)return[60,45,30,255]; const t=(y/66);return[Math.round(240-60*t),Math.round(200-60*t),Math.round(120-50*t),255];},'CAN_9GRID'],
  ['极小图 4x4 纯色',4,4,()=>[128,128,128,255],'NEVER'],
  ['极小图 6x6 纯色',6,6,()=>[200,50,50,255],'NEVER'],
  ['极小图 10x10 纯色',10,10,()=>[50,200,50,255],'NEVER'],
];
for(const [n,w,h,fn,exp] of fixes){
  const {f,g}=await judge(n,w,h,fn);
  console.log(`  ${n.padEnd(34)} => ${g.verdict.padEnd(15)} conf=${String(g.confidence).padEnd(5)} [cf=${(f.cornerFill??0).toFixed(2)} rad=${(f.radialSymmetry??0).toFixed(2)} mono=${f.midMonotonic??'-'} clus=${f.radialMaxCluster??'-'}]`);
  ok(`${n} -> ${exp}`, g.verdict===exp, `实得${g.verdict}`);
}

console.log('\n=== R2-5.2 回归检查：第一轮判对的样本现在还对不对（防止修坏）===');
const regress=[
  ['纯色面板 120x80',120,80,()=>[200,60,60,255],'CAN_9GRID'],
  ['胶囊 160x40',160,40,capsule(160,40,20),'SINGLE_AXIS_ONLY'],
  ['胶囊 300x36（宽）',300,36,capsule(300,36,18),'SINGLE_AXIS_ONLY'],
  ['正圆 100x100',100,100,(x,y)=>{const dx=x-49.5,dy=y-49.5;return dx*dx+dy*dy<=2500?[250,200,50,255]:[0,0,0,0];},'NEVER'],
  ['圆 64x64',64,64,(x,y)=>{const dx=x-31.5,dy=y-31.5;return dx*dx+dy*dy<=1024?[80,180,250,255]:[0,0,0,0];},'NEVER'],
  ['菱形 100x100',100,100,(x,y)=>(Math.abs(x-49.5)+Math.abs(y-49.5))<=50?[180,80,220,255]:[0,0,0,0],'NEVER'],
  ['放射条纹 8 辐',120,120,(x,y)=>{const a=Math.atan2(y-59.5,x-59.5);const v=Math.sin(a*8)>0?255:20;return[v,v,v,255];},'NEVER'],
  ['棋盘格',120,120,(x,y)=>{const v=((Math.floor(x/12)+Math.floor(y/12))%2)?240:30;return[v,v,v,255];},'NEVER'],
  ['对角纹理',120,120,(x,y)=>{const v=((x+y)%16<8)?230:40;return[v,v,v,255];},'NEVER'],
  ['全透明 100x100',100,100,()=>[0,0,0,0],'NEVER'],
];
for(const [n,w,h,fn,exp] of regress){
  const {f,g}=await judge(n,w,h,fn);
  console.log(`  ${n.padEnd(22)} => ${g.verdict.padEnd(15)} [cf=${(f.cornerFill??0).toFixed(2)} rad=${(f.radialSymmetry??0).toFixed(2)}]`);
  ok(`${n} 仍 -> ${exp}`, g.verdict===exp, `实得${g.verdict}`);
}

console.log('\n=== R2-5.3 ★★★危险侧评估：细长条纹被误判 CAN_9GRID ===');
console.log('  工程师刻意不修，理由「特征完全相同，差异不足」。我独立评估风险：');
const danger=[
  ['横条纹 120x40（周期 5px）',120,40,(x,y)=>{const v=(Math.floor(y/5)%2)?235:35;return[v,v,v,255];}],
  ['横条纹 120x40（周期 3px）',120,40,(x,y)=>{const v=(Math.floor(y/3)%2)?235:35;return[v,v,v,255];}],
  ['竖条纹 40x120',40,120,(x,y)=>{const v=(Math.floor(x/5)%2)?235:35;return[v,v,v,255];}],
  ['横条纹 细密 200x30 周期 2px',200,30,(x,y)=>{const v=(Math.floor(y/2)%2)?240:30;return[v,v,v,255];}],
  ['细长椭圆 200x40',200,40,(x,y)=>{const dx=(x-99.5)/100,dy=(y-19.5)/20;return dx*dx+dy*dy<=1?[240,120,60,255]:[0,0,0,0];}],
  ['细长椭圆 300x30',300,30,(x,y)=>{const dx=(x-149.5)/150,dy=(y-14.5)/15;return dx*dx+dy*dy<=1?[200,80,200,255]:[0,0,0,0];}],
];
for(const [n,w,h,fn] of danger){
  const {f,g}=await judge(n,w,h,fn);
  const risky = g.verdict!=='NEVER';
  console.log(`  ${n.padEnd(32)} => ${g.verdict.padEnd(15)} [cf=${(f.cornerFill??0).toFixed(2)} rad=${(f.radialSymmetry??0).toFixed(2)} mono=${f.midMonotonic??'-'}] ${risky?'⚠ 危险侧':''}`);
}
console.log('');
console.log('  ★ 我的评估：');
console.log('  · 细长条纹判CAN_9GRID 的后果：九宫格拉伸时横向不变、纵向把条纹拉成色块');
console.log('    —— 这与「把放射纹拉成楔形」同类，**属于危险侧**（PRD 明确定位是「在生成阶段阻止事故」）。');
console.log('  · 但严重度低于 BUG#1/#2：它不会让小 Q 看错bbox，只会让生成的图拉花，');
console.log('    且 grid9 只产出「建议」（suggestedGrid），人工确认环节能拦住。');
console.log('  · 我认可「不立刻修」的决定（不新增特征就无法稳健区分，硬调阈值会引入新误判），');
console.log('    但要求：**必须在 P1 交接时把这一类标为已知限制，不能默默带过**。');

console.log('\n=== R2-5.4 ★描边宽度敏感性（工程师的诚实说明是否成立）===');
console.log('  我用多个描边宽度扫描，看判据在哪个宽度翻转：');
for(const bw of [1,2,3,4,6,8,12,16,20]){
  const w=140,h=90;
  const {f,g}=await judge('bord'+bw,w,h,(x,y)=>{const e=x<bw||x>=w-bw||y<bw||y>=h-bw;return e?[35,35,45,255]:[215,190,130,255];});
  console.log(`  描边 ${String(bw).padStart(2)}px -> ${g.verdict.padEnd(15)} [rad=${(f.radialSymmetry??0).toFixed(3)} clus=${f.radialMaxCluster??'-'} cf=${(f.cornerFill??0).toFixed(2)}]`);
}
console.log('  => 观察：描边越粗越容易被判NEVER；临界宽度约在 3~6px 之间。');
console.log('  => 真实素材：1-2px 细描边最常见（能正确判）；粗描边（如按钮外发光、3D 边框）');
console.log('     可能落 NEVER —— 是安全侧，但削弱工具价值。');

console.log(`\nR2-5 结果: pass=${pass} fail=${fail}`);
fs.rmSync(tmp,{recursive:true,force:true});
process.exit(fail>0?1:0);
})();
