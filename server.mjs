import {assets} from './assets.mjs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { communication } from './communication.mjs';
import { roles } from './roles.mjs';
import { audits } from './audits.mjs';
import { roleContext } from './role-context.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=process.env.CHAT_DATA||path.join(root,'data'); fs.mkdirSync(path.join(dir,'files'),{recursive:true});
const configPath=path.join(dir,'config.json');
if(!fs.existsSync(configPath))fs.writeFileSync(configPath,JSON.stringify({adminToken:randomBytes(32).toString('hex')},null,2));
const config=JSON.parse(fs.readFileSync(configPath));
const db=new DatabaseSync(path.join(dir,'chat.sqlite')); db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,token TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL,owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL,member TEXT NOT NULL,text TEXT NOT NULL,file TEXT,created TEXT NOT NULL);`);
if(!db.prepare('PRAGMA table_info(members)').all().some(c=>c.name==='disabled'))db.exec('ALTER TABLE members ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
const peers=new Set();
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
async function body(req,limit=65536){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>limit){const e=new Error('内容超过大小限制');e.status=413;throw e;}chunks.push(c);}return Buffer.concat(chunks);}
const json=async (req,limit)=>JSON.parse((await body(req,limit)).toString()||'{}');
const event=value=>{for(const peer of peers)peer.write(`data: ${JSON.stringify(value)}\n\n`);};
const messageSelect=`SELECT m.id,m.room,r.name AS roomName,m.text,m.created,p.id AS senderId,p.name AS sender,p.kind,f.id AS fileId,f.name AS fileName,f.size AS fileSize FROM messages m JOIN rooms r ON r.id=m.room JOIN members p ON p.id=m.member LEFT JOIN files f ON f.id=m.file`;
const dshOrigin=process.env.DSH_ORIGIN;
const pluginApiOnly=process.env.CHAT_PLUGIN_API_ONLY==='true';
const sharedAssets=assets(db,dir);
let auditSupport;
const roleSupport=roles(db,event,id=>comm.decorate(db.prepare(messageSelect+' WHERE m.id=?').get(id)),dshOrigin,(...args)=>auditSupport.publishStatus(...args));
const comm=communication(db,messageSelect,event,roleSupport,(...args)=>auditSupport.enqueue(...args),id=>auditSupport.statusForMessage(id),m=>sharedAssets.decorate(m));
auditSupport=audits(db,event,id=>comm.decorate(db.prepare(messageSelect+' WHERE m.id=?').get(id)),roleSupport,dshOrigin,config.adminToken);
const roleContextSupport=roleContext(db,event,comm,roleSupport,messageSelect,dir,sharedAssets);
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 const url=new URL(req.url,'http://localhost');const p=url.pathname;
 if(pluginApiOnly&&p!=='/health'&&!p.startsWith('/api/'))return send(res,404,{error:'接口不存在'});
 const origin=req.headers.origin,chatOrigin='http://'+req.headers.host;
 const httpsOrigin='https://'+req.headers.host;
 const sameOrigin=origin===chatOrigin||(origin===httpsOrigin&&httpsOrigin===process.env.CHAT_PUBLIC_ORIGIN);
 const dshRoleOrigin=Boolean(dshOrigin)&&origin===dshOrigin&&(p==='/api/roles'||p==='/api/role-sources'||p==='/api/managed-auditor'||p==='/api/managed-roles'||p.startsWith('/api/managed-roles/'));
 if(dshRoleOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 if(req.method==='OPTIONS'&&dshRoleOrigin){res.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
 if(origin&&!sameOrigin&&!dshRoleOrigin&&!['GET','HEAD'].includes(req.method))return send(res,403,{error:'请求来源不允许'});
 if(req.method==='GET'&&(p==='/'||p==='/app.js'||p==='/roles-ui.js'||p==='/style.css'||p==='/markdown-it.min.js'||p==='/icon.svg'||p==='/icon.png'||p==='/icon-192.png'||p==='/icon-512.png'||p==='/manifest.webmanifest')){const name=p==='/'?'index.html':p.slice(1);res.writeHead(200,{'Content-Type':name.endsWith('html')?'text/html; charset=utf-8':name.endsWith('js')?'text/javascript; charset=utf-8':name.endsWith('svg')?'image/svg+xml':name.endsWith('png')?'image/png':name.endsWith('.webmanifest')?'application/manifest+json':'text/css; charset=utf-8','Content-Security-Policy':"default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});return res.end(fs.readFileSync(path.join(root,'public',name)));}
 if(p==='/health'){return send(res,200,{ok:true});}
 const token=(req.headers.authorization||'').replace(/^Bearer /,'');
 if(pluginApiOnly&&!token)return send(res,401,{error:'请使用插件访问令牌'});
 if(p.startsWith('/api/admin/')){if(!equal(token,config.adminToken))return send(res,401,{error:'管理员令牌无效'});
  if(p==='/api/admin/members'&&req.method==='POST'){const b=await json(req);const name=String(b.name||'').trim().slice(0,50);if(!name) return send(res,400,{error:'请填写名称'});const member={id:randomUUID(),name,kind:b.kind==='agent'?'agent':'human',token:randomBytes(32).toString('hex')};db.prepare('INSERT INTO members(id,name,kind,token) VALUES(?,?,?,?)').run(member.id,member.name,member.kind,member.token);return send(res,201,member);}
  return send(res,404,{error:'接口不存在'});
 }
 // Unauthenticated web users share the existing human identity. An explicitly
 // supplied but invalid token is still rejected, so plugins cannot silently
 // fall back to the human identity if their credentials are wrong.
 const member=token?db.prepare('SELECT id,name,kind FROM members WHERE token=? AND disabled=0').get(token):
   db.prepare("SELECT id,name,kind FROM members WHERE kind='human' AND disabled=0 ORDER BY rowid LIMIT 1").get();
 if(!member)return send(res,401,{error:'请使用成员访问令牌登录'});
 if(await sharedAssets.route(req,res,url,member,{send,body}))return;
 if(await roleContextSupport.route(req,res,url,member,{send,json}))return;
 if(await auditSupport.route(req,res,url,member,{send,json}))return;
 if(await roleSupport.route(req,res,url,member,{send,json,createReply:(job,text)=>{
   const source=roleSupport.getJob(job.message).sourceMessage;
   const original=db.prepare(messageSelect+' WHERE m.id=?').get(source);
   const clientMessageId='role-result-'+job.message;
   const replyTo=comm.priorRoleQuote(member.id,clientMessageId);
   const result=comm.create({room:original.room,replyTo,kind:'result',clientMessageId},member,text,id=>{
     db.prepare("UPDATE role_jobs SET status='replied',reply_message=?,updated=? WHERE message=? AND status='running'").run(id,new Date().toISOString(),job.message);
   });
   if(!result.duplicate)event({type:'message',message:result.message});
   return result.message;
 }}))return;
 if(await comm.route(req,res,url,member,{send,json}))return;
 if(p==='/api/me'&&req.method==='GET')return send(res,200,member);
 if(p==='/api/me'&&req.method==='PATCH'){if(member.kind!=='human')return send(res,403,{error:'只有用户可以修改自己的名称'});const b=await json(req);if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>50)return send(res,400,{error:'用户名需为 1 至 50 个字符'});const name=b.name.trim();db.prepare('UPDATE members SET name=? WHERE id=?').run(name,member.id);event({type:'members'});return send(res,200,{...member,name});}
 if(p==='/api/members'&&req.method==='GET')return send(res,200,db.prepare('SELECT id,name,kind FROM members WHERE disabled=0').all());
 const removeMember=p.match(/^\/api\/members\/([^/]+)$/);
 if(removeMember&&req.method==='DELETE'){if(member.kind!=='human')return send(res,403,{error:'只有用户可以管理成员'});const id=decodeURIComponent(removeMember[1]);const target=db.prepare('SELECT id,kind FROM members WHERE id=? AND disabled=0').get(id);if(!target)return send(res,404,{error:'成员不存在'});if(target.kind!=='human'||id===member.id)return send(res,400,{error:'不能移除自己或 Agent'});db.prepare('UPDATE members SET disabled=1 WHERE id=?').run(id);event({type:'members'});return send(res,200,{ok:true});}
 if(p==='/api/rooms'&&req.method==='GET')return send(res,200,db.prepare('SELECT * FROM rooms').all());
 if(p==='/api/rooms'&&req.method==='POST'){if(member.kind!=='human')return send(res,403,{error:'只有用户可以创建群聊'});const b=await json(req);const name=String(b.name||'').trim().slice(0,60);if(!name)return send(res,400,{error:'群聊名称不能为空'});const room={id:randomUUID(),name};db.prepare('INSERT INTO rooms VALUES(?,?)').run(room.id,room.name);event({type:'rooms'});return send(res,201,room);}
 const removeRoom=p.match(/^\/api\/rooms\/([^/]+)$/);
 if(removeRoom&&req.method==='DELETE'){
   if(member.kind!=='human')return send(res,403,{error:'只有用户可以删除群聊'});
   const id=decodeURIComponent(removeRoom[1]), confirmation=await json(req);
   const room=db.prepare('SELECT name FROM rooms WHERE id=?').get(id);
   if(!room)return send(res,404,{error:'群聊不存在'});
   if(confirmation.name!==room.name)return send(res,400,{error:'群名称不匹配'});
   db.exec('BEGIN IMMEDIATE');
   let files;
   try{
     files=db.prepare('SELECT DISTINCT file FROM messages WHERE room=? AND file IS NOT NULL').all(id);
     const messages='SELECT id FROM messages WHERE room=?';
     const jobs=`SELECT message FROM role_jobs WHERE message IN (${messages})
       UNION SELECT job_id FROM role_job_origins WHERE original_message IN (${messages})`;
     db.prepare(`DELETE FROM role_decisions WHERE source_job IN (${jobs})`).run(id,id);
     db.prepare(`DELETE FROM role_messages WHERE message IN (${messages}) OR source_job IN (${jobs})`).run(id,id,id);
     db.prepare(`DELETE FROM role_jobs WHERE message IN (${jobs})`).run(id,id);
     db.prepare(`DELETE FROM role_job_origins WHERE original_message IN (${messages})`).run(id);
     for(const table of ['deliveries','message_meta','audit_jobs','reactions'])db.prepare(`DELETE FROM ${table} WHERE message IN (${messages})`).run(id);
     for(const table of ['room_roles','room_auditors','role_blacklist','messages'])db.prepare(`DELETE FROM ${table} WHERE room=?`).run(id);
     db.prepare('DELETE FROM rooms WHERE id=?').run(id);
     const removeFile=db.prepare('DELETE FROM files WHERE id=? AND NOT EXISTS (SELECT 1 FROM messages WHERE file=?) AND NOT EXISTS (SELECT 1 FROM shared_assets WHERE id=?)');
     files=files.filter(({file})=>removeFile.run(file,file,file).changes);
     db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   for(const {file} of files)fs.unlink(path.join(dir,'files',file),error=>{if(error&&error.code!=='ENOENT')console.error('删除群附件失败',error.code);});
   event({type:'rooms'});
   return send(res,200,{ok:true});
 }
 if(p==='/api/events'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(': connected\n\n');peers.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),20000);req.on('close',()=>{peers.delete(res);clearInterval(timer);});return;}
 if(p==='/api/messages'&&req.method==='GET'){const room=url.searchParams.get('room')||'general';const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)return send(res,400,{error:'after 参数无效'});const messages=after?db.prepare(messageSelect+' WHERE m.room=? AND m.id>? ORDER BY m.id LIMIT 200').all(room,after):db.prepare('SELECT * FROM ('+messageSelect+' WHERE m.room=? ORDER BY m.id DESC LIMIT 200) ORDER BY id').all(room);return send(res,200,messages.map(comm.decorate));}
 const messageDetails=p.match(/^\/api\/messages\/(\d+)$/);
 if(messageDetails&&req.method==='GET'){
   const message=db.prepare(messageSelect+' WHERE m.id=? AND m.room=?').get(Number(messageDetails[1]),url.searchParams.get('room'));
   return message?send(res,200,comm.decorate(message)):send(res,404,{error:'找不到该群里的引用消息'});
 }
 const messageContent=p.match(/^\/api\/messages\/(\d+)\/content$/);
 if(messageContent&&req.method==='GET'){const row=db.prepare('SELECT text FROM messages WHERE id=?').get(Number(messageContent[1]));if(!row)return send(res,404,{error:'消息不存在'});res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"});return res.end(row.text);}
 if(p==='/api/messages'&&req.method==='POST'){const b=await json(req,1024*1024);const room=b.room||'general';const text=String(b.text||'').trim();if(b.assetId!=null){if(b.fileId)throw Error('共享表情与附件只能选一个');b.fileId=sharedAssets.requireKind(b.assetId,'sticker');}if(text.length>100000)return send(res,400,{error:'消息最长 100000 字符'});if(!text&&!b.fileId)return send(res,400,{error:'消息不能为空'});if(!db.prepare('SELECT id FROM rooms WHERE id=?').get(room))return send(res,400,{error:'群聊不存在'});if(b.fileId&&b.assetId==null&&!db.prepare('SELECT id FROM files WHERE id=? AND owner=?').get(b.fileId,member.id))return send(res,400,{error:'附件不存在或不属于你'});const {message,duplicate}=comm.create(b,member,text);if(!duplicate)event({type:'message',message});return send(res,duplicate?200:201,message);}
 if(p==='/api/files'&&req.method==='POST'){const data=await body(req,25*1024*1024);const name=String(url.searchParams.get('name')||'file').replace(/[\x00-\x1f/\\]/g,'_').slice(0,180);const id=randomUUID();fs.writeFileSync(path.join(dir,'files',id),data);db.prepare('INSERT INTO files VALUES(?,?,?,?)').run(id,name,data.length,member.id);return send(res,201,{id,name,size:data.length});}
 if(p.startsWith('/api/files/')&&req.method==='GET'){const f=db.prepare('SELECT * FROM files WHERE id=?').get(p.slice(11));if(!f)return send(res,404,{error:'文件不存在'});res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':f.size,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Cache-Control':'private, no-store'});return fs.createReadStream(path.join(dir,'files',f.id)).pipe(res);}
 send(res,404,{error:'接口不存在'});
 }catch(e){if(!res.headersSent)send(res,e.status||400,{error:e instanceof SyntaxError?'请求格式错误':e.message});else res.end();}});
const auditTimer=setInterval(()=>auditSupport.pump().catch(()=>console.error('统一审查队列处理失败')),500);
auditTimer.unref();
server.on('close',()=>clearInterval(auditTimer));
server.listen(Number(process.env.PORT||8910),process.env.HOST||'0.0.0.0',()=>console.log(`LAN Chat ready on port ${process.env.PORT||8910}`));
