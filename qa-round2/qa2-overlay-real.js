'use strict';
/** 第二轮 · ★端到端验证：合法纯色 PSD 会不会导致 ir_overlay 不显示底图 */
const fs=require('fs'),path=require('path'),os=require('os');
const shim=require('../src/psd/canvas-shim');
shim.installCanvasShim();
const agpsd=require('ag-psd');
const { buildOverlayHtml } = (()=>{ try{return require('../src/report/ir-overlay');}catch(e){return {};} })();
console.log('ir-overlay 导出:',Object.keys(require('../src/report/ir-overlay')).join(', '));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qa2-ov-'));
function solid(w,h,fn){const im=shim.createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);const i=(y*w+x)*4;
    im.data[i]=r;im.data[i+1]=g;im.data[i+2]=b;im.data[i+3]=a;}return im;}

(async()=>{
console.log('\n=== 场景：合法 PSD 就是「纯色底框 + 一个纯色按钮」这种极简设计稿 ===');
console.log('（真实小 Q 的 PSD 很可能长这样：一个色块 + 一个色块，不是渐变不是纹理）');
const layers=[
  {name:'按钮',left:20,top:20,right:70,bottom:60,imageData:solid(50,40,()=>[230,180,60,255]),opacity:1,blendMode:'normal'},
  {name:'底框',left:0,top:0,right:100,bottom:80,imageData:solid(100,80,()=>[40,90,160,255]),opacity:1,blendMode:'normal'},
];
const p=path.join(tmp,'solid.psd');
fs.writeFileSync(p, agpsd.writePsdBuffer({width:100,height:80,children:layers,
  imageData:shim.composeImageData(100,80,layers)}));
const {readPsdFile,compositeImageData,MODE}=require('../src/psd/reader');
const parsed=readPsdFile(p,{mode:MODE.FULL});
const comp=compositeImageData(parsed.psd);
// 统计
const seen=new Set(); let nz=0;
for(let i=0;i<comp.data.length;i+=4){const r=comp.data[i],g=comp.data[i+1],b=comp.data[i+2];
  if(r||g||b)nz++; if(seen.size<64)seen.add(`${r>>3},${g>>3},${b>>3},${a(0)}`);}
function a(i){return comp.data[i+3]>>3;}
console.log('  合成图统计: 非黑 '+(100*nz/(comp.width*comp.height)).toFixed(0)+'%, 颜色数='+seen.size);
console.log('  => 这是一张完全正常的图：底框蓝 + 按钮黄');

const mod=require('../src/report/ir-overlay');
// 直接调 validateComposite: 它是模块内函数，可能未导出
const src=fs.readFileSync(path.join(__dirname,'..','src','report','ir-overlay.js'),'utf8');
// 用HTML 产物验证：跑真实命令
console.log('\n=== 跑真实 CLI 生成 ir_overlay.html ===');
const { execFileSync }=require('child_process');
const out=path.join(tmp,'out');
try{
  execFileSync('C:/Program Files/nodejs/node.exe',
    ['bin/fgui-rb.js','psd-ir','--root',process.cwd().replace(/\\/g,'/'),'--psd',p,'--label','S','--out',out],
    {env:{...process.env,NODE_PATH:'C:/Users/Lee/.workbuddy/binaries/node/workspace/node_modules'},stdio:'pipe'});
  const html=fs.readFileSync(path.join(out,'ir_overlay.S.html'),'utf8');
  const hasImg=html.includes('data:image/png;base64');
  const hasWarn=/合成|底图|不可用|退化/.test(html);
  console.log('  ir_overlay.S.html 是否内嵌底图: '+hasImg);
  console.log('  是否显示警告: '+hasWarn);
  const m=html.match(/合成[^<]{0,200}/);
  if(m) console.log('  警告文案: '+m[0].slice(0,180));
  if(!hasImg){
    console.log('');
    console.log('  ★★★结论：合法纯色 PSD 的底图被抑制了！');
    console.log('  这正是 team-lead担心的「误报导致小 Q 看不到底图」—— 已确认发生。');
  }
}catch(e){ console.log('  CLI 失败:',(e.stderr||e.message).toString().slice(0,300)); }
fs.rmSync(tmp,{recursive:true,force:true});
})();
