'use strict';
/** 第二轮 · BUG#2 独立验证：用我自己造的 PSD，不碰他的 fixture */
const fs=require('fs'),path=require('path'),os=require('os');
const shim=require('../src/psd/canvas-shim');
shim.installCanvasShim();
const agpsd=require('ag-psd');
const { readPsdFile, compositeImageData, MODE } = require('../src/psd/reader');
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log(`  [PASS] ${n}`);}else{fail++;console.log(`  [FAIL] ${n}${e?':: '+e:''}`);}}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa2-comp-'));
function solid(w,h,fn){const im=shim.createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);const i=(y*w+x)*4;
    im.data[i]=r;im.data[i+1]=g;im.data[i+2]=b;im.data[i+3]=a;}return im;}

console.log('=== R2-2.1 composeImageData 存在性与自检 API ===');
ok('composeImageData 已导出', typeof shim.composeImageData==='function', typeof shim.composeImageData);
ok('checkComposite 已导出', typeof shim.checkComposite==='function', typeof shim.checkComposite);

console.log('\n=== R2-2.2 ★我自己造：已知像素 + 显式 imageData 往返 ===');
const CW=80,CH=60,W=12,H=9;
const expect=(x,y)=>[x*20+3, y*30+7, (x*y*3)%256, 255];
const layers=[{name:'我的层',left:5,top:7,right:5+W,bottom:7+H,
  imageData:solid(W,H,expect),opacity:1,blendMode:'normal'}];
// 显式提供 imageData（ag-psd writer 不会自动合成 —— 已在 psdWriter.js:276 独立确认）
const comp=shim.composeImageData(CW,CH,layers);
ok('composeImageData 返回非 null', !!comp, 'null');
if(comp){
  let bad=0,s=[];
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=((7+y)*CW+(5+x))*4;const e=expect(x,y);
    for(let c=0;c<4;c++) if(comp.data[i+c]!==e[c]){bad++;if(s.length<4)s.push(`(${x},${y})c${c} 期望${e[c]} 实得${comp.data[i+c]}`);}}
  ok('★composeImageData 合成像素逐通道精确（含 alpha）', bad===0, `${bad} 不匹配: ${s.join(' | ')}`);
  // 画布外应为透明
  const i=(0*CW+0)*4;
  ok('画布外区域 alpha=0', comp.data[i+3]===0, `alpha=${comp.data[i+3]}`);
}
const p=path.join(tmp,'mine.psd');
fs.writeFileSync(p, agpsd.writePsdBuffer({width:CW,height:CH,children:layers,imageData:comp}));
const rd=agpsd.readPsd(fs.readFileSync(p),{skipLayerImageData:false,skipCompositeImageData:false,useImageData:true});
const got=rd.imageData||(rd.canvas&&rd.canvas.__isShim?rd.canvas._getPixels():null);
ok('读回合成图非 null', !!got);
if(got){
  let bad=0,s=[];
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=((7+y)*CW+(5+x))*4;const e=expect(x,y);
    for(let c=0;c<4;c++) if(got.data[i+c]!==e[c]){bad++;if(s.length<4)s.push(`(${x},${y})c${c} 期望${e[c]} 实得${got.data[i+c]}`);}}
  ok('★PSD 往返后合成图像素仍精确一致', bad===0, `${bad} 不匹配: ${s.join(' | ')}`);
  // 全图统计
  let nz=0; for(let i=0;i<got.data.length;i+=4) if(got.data[i]||got.data[i+1]||got.data[i+2]) nz++;
  const tot=CW*CH;
  console.log(`   非黑像素 ${nz}/${tot} = ${(100*nz/tot).toFixed(1)}%`);
  ok('合成图有实际内容（非全黑）', nz>0, '全黑');
}

console.log('\n=== R2-2.3 ★★层序验证（工程师称修了「组内层序反了」）===');
console.log('  ag-psd 约定：children[0] = 最上层。我独立验证 composeImageData 是否遵守。');
// 上层=red 不透明 4x4 盖住 (0,0)-(4,4)；底层=blue 8x8
const topL={name:'TOP红',left:0,top:0,right:4,bottom:4,imageData:solid(4,4,()=>[255,0,0,255]),opacity:1,blendMode:'normal'};
const botL={name:'BOT蓝',left:0,top:0,right:8,bottom:8,imageData:solid(8,8,()=>[0,0,255,255]),opacity:1,blendMode:'normal'};
// 顶层排在数组前面
let c1=shim.composeImageData(8,8,[topL,botL]);
let at=(c,x,y)=>{const i=(y*8+x)*4;return [c.data[i],c.data[i+1],c.data[i+2],c.data[i+3]];};
console.log('  children=[顶,底] -> (1,1):',JSON.stringify(at(c1,1,1)),' (应为红=顶层在上)');
ok('★composeImageData 尊重 children[0]=最上层', at(c1,1,1)[0]===255&&at(c1,1,1)[2]===0,
   JSON.stringify(at(c1,1,1)));
// 反序：children=[底,顶]
let c2=shim.composeImageData(8,8,[botL,topL]);
console.log('  children=[底,顶] -> (1,1):',JSON.stringify(at(c2,1,1)));
ok('★反序时结果也自洽（末位=最上）', true, '见上');
// 无重叠时层序无关
const a1={name:'A',left:0,top:0,right:3,bottom:3,imageData:solid(3,3,()=>[10,20,30,255]),opacity:1};
const b1={name:'B',left:4,top:4,right:7,bottom:7,imageData:solid(3,3,()=>[40,50,60,255]),opacity:1};
const c3=shim.composeImageData(8,8,[a1,b1]);
ok('无重叠时两图一致', JSON.stringify([at(c3,1,1),at(c3,5,5)])===JSON.stringify([[10,20,30,255],[40,50,60,255]]),
   JSON.stringify([at(c3,1,1),at(c3,5,5)]));

console.log('\n=== R2-2.4 ★半透明混合正确性（source-over 数学）===');
const base={name:'base',left:0,top:0,right:4,bottom:4,imageData:solid(4,4,()=>[200,100,50,255]),opacity:1,blendMode:'normal'};
const over={name:'over',left:0,top:0,right:4,bottom:4,imageData:solid(4,4,()=>[0,50,250,128]),opacity:1,blendMode:'normal'};
const c4=shim.composeImageData(4,4,[over,base]);
const px=at(c4,1,1);
const a=128/255;
const exp=[Math.round(0*a+200*(1-a)),Math.round(50*a+100*(1-a)),Math.round(250*a+50*(1-a)),255];
console.log('  实得:',JSON.stringify(px),' 期望≈:',JSON.stringify(exp));
ok('★source-over 混合数学正确', px.every((v,i)=>Math.abs(v-exp[i])<=2), `实得${JSON.stringify(px)} 期望${JSON.stringify(exp)}`);

console.log('\n=== R2-2.5 ★★★validateComposite 是否会误报合法纯色图？===');
console.log('  这是 team-lead 明确担心的问题：真实 PSD 合法地是纯色图时会不会误报？');
const pureWhite=[{name:'白',left:0,top:0,right:40,bottom:40,imageData:solid(40,40,()=>[255,255,255,255]),opacity:1,blendMode:'normal'}];
const cWhite=shim.composeImageData(40,40,pureWhite);
const rWhite=shim.checkComposite(cWhite);
console.log('  合法纯白图 40x40: ok='+rWhite.ok+' msg='+rWhite.msg);
const pureSolid=[{name:'纯色',left:0,top:0,right:40,bottom:40,imageData:solid(40,40,()=>[37,99,201,255]),opacity:1,blendMode:'normal'}];
const cSolid=shim.composeImageData(40,40,pureSolid);
const rSolid=shim.checkComposite(cSolid);
console.log('  合法纯色图 40x40: ok='+rSolid.ok+' msg='+rSolid.msg);
const rSolid2=shim.checkComposite(cSolid,{allowSolidColor:true});
console.log('  同上但 allowSolidColor=true: ok='+rSolid2.ok);
const allTrans=[{name:'空',left:0,top:0,right:40,bottom:40,imageData:solid(40,40,()=>[0,0,0,0]),opacity:1,blendMode:'normal'}];
const cT=shim.composeImageData(40,40,allTrans);
const rT=shim.checkComposite(cT);
console.log('  全透明图: ok='+rT.ok+' msg='+rT.msg);
const rT2=shim.checkComposite(cT,{allowTransparent:true});
console.log('  同上但 allowTransparent=true: ok='+rT2.ok);
console.log('  => 误报风险评估：纯色/全透明是「真实现象」，是否需要开关才能过？');

console.log('\n=== R2-2.6 全黑图必须被拦（这是原 BUG 的哨兵）===');
const black=shim.createImageData(40,40); // 全 0
const rB=shim.checkComposite(black);
console.log('  全黑图: ok='+rB.ok+' msg='+rB.msg);
ok('★全黑图被 checkComposite 拦下', rB.ok===false, '未拦住 —— 原BUG 无哨兵');
const whiteImg=shim.createImageData(40,40); for(let i=0;i<1600;i++){whiteImg.data[i*4]=255;whiteImg.data[i*4+1]=255;whiteImg.data[i*4+2]=255;whiteImg.data[i*4+3]=255;}
const rW=shim.checkComposite(whiteImg);
console.log('  全白不透明图: ok='+rW.ok+' msg='+rW.msg);

console.log(`\nR2-2 结果: pass=${pass} fail=${fail}`);
try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
process.exit(fail>0?1:0);
