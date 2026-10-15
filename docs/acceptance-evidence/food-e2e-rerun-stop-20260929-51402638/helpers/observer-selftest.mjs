import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process'; import {fileURLToPath} from 'node:url';
const audit=path.dirname(fileURLToPath(import.meta.url)); const pwsh='C:\\Users\\evstm\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe';
const pidFile=path.join(audit,'observer-selftest.pid'), receipt=path.join(audit,'observer-selftest-receipt.json'), ready=path.join(audit,'observer-selftest-ready.json'); for(const p of [pidFile,receipt,ready])try{fs.unlinkSync(p)}catch{}
const sparse={SystemRoot:process.env.SystemRoot};
const observer=spawn(pwsh,['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(audit,'capture-child-env.ps1'),'-PidFile',pidFile,'-OutputFile',receipt,'-ReadyFile',ready],{windowsHide:true,stdio:'ignore',env:sparse}); const observerDone=new Promise(r=>observer.on('close',r));
const expected=path.join(audit,'selftest-temp'), videoTemp=path.join(audit,'selftest-video-temp');
for(let i=0;i<200&&!fs.existsSync(ready);i++)await new Promise(r=>setTimeout(r,50)); if(!fs.existsSync(ready))throw new Error('observer not ready');
const root=spawn(process.execPath,['-e',`const{spawn}=require('child_process');const p=spawn(${JSON.stringify(pwsh)},['-NoProfile','-Command','Start-Sleep -Seconds 8'],{windowsHide:true,stdio:'ignore',env:process.env});p.on('close',()=>setTimeout(()=>process.exit(0),300));`],{windowsHide:true,stdio:'ignore',env:{...sparse,TEMP:expected,TMP:expected,VIDEOAUTO_TEMP_DIR:videoTemp}}); const rootDone=new Promise(r=>root.on('close',r));
fs.writeFileSync(pidFile,String(root.pid)); await rootDone; await observerDone;
const result=JSON.parse(fs.readFileSync(receipt,'utf8')); const matching=result.records.filter(x=>x.TEMP===expected&&x.TMP===expected&&x.VIDEOAUTO_TEMP_DIR===videoTemp);
if(result.status!=='complete'||result.records.length<2||matching.length<2||result.capture_errors.length) throw new Error('observer selftest failed');
const summary={ok:true,records:result.records.length,matching:matching.length,capture_errors:0,allowlisted_only:result.only_allowlisted_environment_keys_recorded}; fs.writeFileSync(path.join(audit,'observer-selftest-summary.json'),JSON.stringify(summary,null,2)+'\n'); console.log(JSON.stringify(summary));
