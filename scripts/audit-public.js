import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
const root=path.resolve(import.meta.dirname,"..");
const failures=[];
const skip=new Set([".git","node_modules","coverage",".git-hooks"]);
const email=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const protocolExamples=new Set(["111@s.whatsapp.net","222@s.whatsapp.net","teacher@s.whatsapp.net","lab@g.us","dev@s.whatsapp.net","project@g.us","%@g.us","group@g.us"]);
const keyPatterns=[/\bAIza[A-Za-z0-9_-]{30,}\b/,/\bAQ\.[A-Za-z0-9_-]{25,}\b/,/\bya29\.[A-Za-z0-9._-]{30,}\b/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
let files=0;
function scan(dir){
 for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(skip.has(e.name))continue;
  const abs=path.join(dir,e.name),rel=path.relative(root,abs).replaceAll("\\","/");
  if(e.isSymbolicLink()){failures.push(rel+": symbolic link is not allowed");continue;}
  if(e.isDirectory()){
   if(/^(?:\.local|Settings|MemoryVault|Research|Backups|RestoreTests|\.openclaw)(?:\/|$)|^automation\/n8n\/runtime(?:\/|$)/.test(rel)){failures.push(rel+": private runtime directory");continue;}
   scan(abs);continue;
  }
  files++;
  if(/(?:^|\/)(?:creds|service-secrets|access|auth-profiles)\.json$|\.sqlite(?:-|$)|\.db(?:-|$)|\.log$|\.(?:pem|key|p12|pfx)$|(?:^|\/)\.env(?:\.|$)/.test(rel)&&!rel.endsWith(".example.sqlite")&&rel!==".env.example")failures.push(rel+": private file type");
  const bytes=fs.readFileSync(abs);
  let text=bytes.toString("utf8");
  if(rel.endsWith(".example.sqlite")){const sample=new DatabaseSync(abs,{readOnly:true});try{text=JSON.stringify(["example_info","example_messages"].map(table=>sample.prepare("SELECT * FROM "+table).all()));}finally{sample.close();}}
  if(keyPatterns.some(p=>p.test(text)))failures.push(rel+": credential-shaped value");
  if(/(?:C:[\\/]+Users[\\/]+)[^\\/\s"'<>]+/i.test(text))failures.push(rel+": user-specific home path");
  for(const match of text.matchAll(email)){
   const domain=match[0].split("@")[1].toLowerCase();
   if(!["example.test","example.com","example.org","example.net"].includes(domain)&&!protocolExamples.has(match[0]))failures.push(rel+": non-example email address");
  }
  if(rel.endsWith(".example.sqlite")){
   const db=new DatabaseSync(abs,{readOnly:true});
   try{
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t=>t.name);
    if(tables.some(t=>!["example_info","example_messages"].includes(t)))failures.push(rel+": unexpected example database table");
    if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")failures.push(rel+": invalid example database");
    if(!tables.includes("example_info")||db.prepare("SELECT example FROM example_info").get()?.example!==1)failures.push(rel+": database is not marked as a dummy");
   }finally{db.close();}
  }
 }
}
scan(root);
const accounts=JSON.parse(fs.readFileSync(path.join(root,"examples/Settings/email-accounts.json")));
if(accounts.some(a=>a.enabled!==false||a.appPassword||a.accessToken||a.refreshToken||!a.email.endsWith("@example.test")))failures.push("Example mailbox settings must remain disabled with blank credentials");
const keys=fs.readFileSync(path.join(root,"examples/Settings/gemini-api-keys.txt"),"utf8").split(/\r?\n/).filter(s=>s.trim()&&!s.trim().startsWith("#"));
if(keys.length)failures.push("Example Gemini pool must contain comments only");
const tokens=JSON.parse(fs.readFileSync(path.join(root,"examples/runtime/service-secrets.example.json")));
if(Object.values(tokens).some(v=>v!==""))failures.push("Example service tokens must be blank");
const access=JSON.parse(fs.readFileSync(path.join(root,"examples/runtime/hub/access.example.json")));
if(access.token)failures.push("Example owner token must be blank");
console.log(JSON.stringify({ok:failures.length===0,filesChecked:files,failures},null,2));
if(failures.length)process.exitCode=1;
