const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const a=fs.readFileSync(path.join(root,'public','app.js'),'utf8');
const v=fs.readFileSync(path.join(root,'public','voice.js'),'utf8');
const m=JSON.parse(fs.readFileSync(path.join(root,'data','update-manifest.json'),'utf8'));
const manifest=fs.readFileSync(path.join(root,'android','AndroidManifest.xml'),'utf8');
const checks=[['manifest version',Number.isInteger(m.version)],['HTTPS gate',a.includes('https')],['schema validation',a.includes('validateContentPackage')],['local override cache',a.includes('eq-content-override-v1')],['manual settings entry',v.includes('内容更新')],['no silent APK install',!manifest.includes('REQUEST_INSTALL_PACKAGES')]];
let bad=0; checks.forEach(([n,x])=>{console.log(`${x?'PASS':'FAIL'} ${n}`);if(!x)bad++}); process.exit(bad?1:0);
