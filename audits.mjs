import {randomUUID} from 'node:crypto';
import {serverAuditor} from './server-auditor.mjs';

// One lightweight classifier per plugin identity; its verdict only creates an
// ordinary role job, never grants the classifier authority to execute tools.
export function audits(db,event,selectMessage,roles,dshOrigin,adminToken){
  db.exec(`CREATE TABLE IF NOT EXISTS auditor_sources(owner TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(owner,provider));
    CREATE TABLE IF NOT EXISTS audit_jobs(message INTEGER NOT NULL,owner TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',token TEXT,claimed_at INTEGER,error TEXT,PRIMARY KEY(message,owner,provider));
    CREATE TABLE IF NOT EXISTS role_blacklist(role_id TEXT NOT NULL,owner TEXT NOT NULL,room TEXT NOT NULL,blocked_at TEXT NOT NULL,reason TEXT,PRIMARY KEY(role_id,room));`);
  if(!db.prepare('PRAGMA table_info(audit_jobs)').all().some(c=>c.name==='reason')){
    db.exec('ALTER TABLE audit_jobs ADD COLUMN reason TEXT');
  }
  const statesForMessage=db.prepare('SELECT status FROM audit_jobs WHERE message=?');
  const sourceJobs=db.prepare('SELECT message,role_id,status,auto_routed FROM role_jobs WHERE message=? OR message IN (SELECT job_id FROM role_job_origins WHERE original_message=?)');
  function statusForMessage(id){
    const states=new Set(statesForMessage.all(id).map(row=>row.status));
    if(!states.size)return undefined;
    if(sourceJobs.all(id,id).some(job=>job.auto_routed===0))return 'routed';
    if(states.has('pending')||states.has('claimed'))return 'pending';
    const unavailable=states.has('unavailable')||states.has('notified');
    if(states.has('routed'))return states.has('failed')||unavailable?'partial':'routed';
    if(states.has('failed'))return 'failed';
    if(unavailable&&!states.has('ignored'))return 'unavailable';
    return 'ignored';
  }
  function publishStatus(messageId,room){
    event({type:'audit-status',messageId,room,routeStatus:statusForMessage(messageId)});
  }
  const unified=serverAuditor(db,adminToken,publishStatus,selectMessage);
  const availableRoles=db.prepare(`SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort
    FROM room_roles rr JOIN roles r ON r.id=rr.role_id JOIN members owner ON owner.id=r.owner
    WHERE rr.room=? AND r.deleted=0 AND owner.disabled=0
      AND r.id NOT IN (SELECT role_id FROM role_blacklist WHERE room=?)`);
  function candidateRoles(message, row){
    const sender=message.roleReply?.roleId||message.roleSender?.roleId;
    return availableRoles.all(message.room,message.room).filter(role=>role.id!==sender&&
      (row.provider==='server'||role.owner===row.owner&&role.provider===row.provider));
  }
  function complete(row,message,verdict){
    const created=[];
    let status='ignored',error=verdict.error?String(verdict.error).slice(0,500):null;
    db.exec('BEGIN IMMEDIATE');
    try{
      const candidates=candidateRoles(message,row);
      const ids=verdict.roleIds??(verdict.roleId==null?null:[verdict.roleId]);
      const byId=new Map(candidates.map(role=>[role.id,role]));
      if(error){
        status='failed';
      }else if(!candidates.length){
        status='unavailable';
      }else if(!Array.isArray(ids)||ids.length>candidates.length||ids.some(id=>!byId.has(id))||new Set(ids).size!==ids.length){
        status='failed';
        error='审计员选择的角色列表无效';
      }else{
        for(const roleId of ids){
          const role=byId.get(roleId);
          const last=db.prepare(`SELECT j.message,j.session_id FROM role_jobs j JOIN messages m
            ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message)
            WHERE m.room=? AND m.id<? AND j.role_id=? AND j.session_id IS NOT NULL AND j.status IN ('running','replied')
            ORDER BY m.id DESC LIMIT 1`).get(message.room,message.id,role.id);
          if(last){role.sessionId=last.session_id;role.continuationOf=last.message;}
          role.autoRouted=true;
          const jobId=roles.insertAdditionalJob(message.id,role);
          if(jobId!==null)created.push(jobId);
          status='routed';
        }
      }
      db.prepare(`UPDATE audit_jobs SET status=?,token=NULL,claimed_at=NULL,error=?,reason=?
        WHERE message=? AND owner=? AND provider=?`).run(status,error,
        typeof verdict.reason==='string'?verdict.reason.slice(0,500):null,row.message,row.owner,row.provider);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    for(const jobId of created)event({type:'role-job',job:roles.getJob(jobId)});
    publishStatus(message.id,message.room);
    return status;
  }
  const summarize=x=>({id:x.id,sender:x.roleReply?.roleName||x.roleSender?.roleName||x.sender,senderRoleId:x.roleReply?.roleId||x.roleSender?.roleId||null,kind:x.kind,replyTo:x.replyTo,text:x.asDocument||x.text.length>600?`[文档，${x.text.length} 字，查看 /api/messages/${x.id}/content]`:x.text,...(x.fileId?{attachment:{description:(/\.(png|jpe?g|gif|webp|bmp)$/i.test(x.fileName)?'图片':'附件')+'：'+x.fileName,messageId:x.id,url:'/api/files/'+x.fileId}}:{})});
  function enqueue(messageId,room,roleId,text,replyTo,fileId,senderKind){
    if(roleId||(!text&&!fileId))return;
    const roleSender=senderKind==='agent'&&db.prepare('SELECT role_id,target_role_id FROM role_messages WHERE message=? UNION ALL SELECT role_id,NULL FROM role_jobs WHERE reply_message=? LIMIT 1').get(messageId,messageId);
    if(roleSender?.target_role_id)return;
    // 规则前置：人类直接回复某条角色消息时，不调审计，直接派给该角色。
    if(senderKind==='human'&&Number.isSafeInteger(replyTo)){
      const quoted=selectMessage(replyTo);
      const quotedRole=quoted?.roleSender||quoted?.roleReply;
      if(quotedRole){
        const role=db.prepare('SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.id=? AND r.deleted=0').get(room,quotedRole.roleId);
        if(role){
          const previous=db.prepare("SELECT message,session_id FROM role_jobs WHERE role_id=? AND (message=? OR reply_message=?) AND session_id IS NOT NULL AND status IN ('running','replied')").get(role.id,quotedRole.sourceJob??0,replyTo);
          roles.insertAdditionalJob(messageId,{...role,autoRouted:true,sessionId:previous?.session_id,continuationOf:previous?.message});
        }
        return;
      }
    }
    // 连续对话：上一条与本条间隔 >= 1 小时视为新会话，解除本群所有角色黑名单。
    const prev=db.prepare('SELECT created FROM messages WHERE room=? AND id<? ORDER BY id DESC LIMIT 1').get(room,messageId);
    if(!prev||Date.now()-Date.parse(prev.created)>=3600000)db.prepare('DELETE FROM role_blacklist WHERE room=?').run(room);
    if(unified.enqueue(messageId,room))return;
    db.prepare(`INSERT OR IGNORE INTO audit_jobs(message,owner,provider,model)
      SELECT ?,s.owner,s.provider,s.model FROM auditor_sources s WHERE EXISTS
      (SELECT 1 FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.owner=s.owner AND r.provider=s.provider AND r.deleted=0 AND r.id IS NOT ?)`).run(messageId,room,roleSender?.role_id??null);
  }
  async function route(req,res,url,member,{send,json}){
    const p=url.pathname;
    if(['/api/auditor-profiles','/api/auditor-profiles/models','/api/audit-history'].includes(p)){
      if(member.kind!=='human')return send(res,403,{error:'只有用户可以管理审查员'}),true;
      if(p==='/api/audit-history'&&req.method==='GET')return send(res,200,unified.history(url.searchParams.get('room'))),true;
      if(p==='/api/auditor-profiles'&&req.method==='GET')return send(res,200,unified.profiles()),true;
      if(p==='/api/auditor-profiles'&&req.method==='POST')return send(res,200,unified.saveProfile(await json(req))),true;
      if(p==='/api/auditor-profiles/models'&&req.method==='POST')return send(res,200,{models:await unified.profileModels(await json(req))}),true;
      return send(res,405,{error:'请求方式不支持'}),true;
    }
    const roomAuditor=p.match(/^\/api\/rooms\/([^/]+)\/auditor$/);
    if(roomAuditor&&['GET','POST'].includes(req.method)){
      if(member.kind!=='human')return send(res,403,{error:'只有用户可以查看审查员设置'}),true;
      const room=decodeURIComponent(roomAuditor[1]);
      if(!db.prepare('SELECT 1 FROM rooms WHERE id=?').get(room))return send(res,404,{error:'群聊不存在'}),true;
      if(req.method==='GET')return send(res,200,unified.publicConfig(room)),true;
      const input=await json(req);
      if(input.profileId!==null&&typeof input.profileId!=='string')return send(res,400,{error:'请选择审查员'}),true;
      return send(res,200,unified.selectProfile(room,input.profileId)),true;
    }
    if(p==='/api/managed-auditor'&&['GET','POST'].includes(req.method)){
      if(!dshOrigin||req.headers.origin!==dshOrigin||member.kind!=='human')return send(res,403,{error:'请在 DSH 插件中管理审计员'}),true;
      if(req.method==='GET'){const rows=db.prepare("SELECT owner,provider,model FROM auditor_sources WHERE provider='dsh'").all();send(res,200,rows);return true;}
      const b=await json(req),source=db.prepare("SELECT models FROM role_sources WHERE owner=? AND provider='dsh'").get(b.owner);
      if(typeof b.model!=='string'||!source||b.model&&!JSON.parse(source.models).some(m=>m.id===b.model))throw Error('请选择 DSH 插件提供的模型');
      if(b.model)db.prepare("INSERT INTO auditor_sources VALUES(?,'dsh',?) ON CONFLICT(owner,provider) DO UPDATE SET model=excluded.model").run(b.owner,b.model);
      else db.prepare("DELETE FROM auditor_sources WHERE owner=? AND provider='dsh'").run(b.owner);
      send(res,200,{ok:true});return true;
    }
    if(p==='/api/auditor/config'&&req.method==='POST'){
      if(member.kind!=='agent')return send(res,403,{error:'仅插件可以配置审计员'}),true;
      const b=await json(req);if(!['codex','dsh'].includes(b.provider)||typeof b.model!=='string'||b.model.length>300)throw Error('审计员模型无效');
      if(b.model)db.prepare('INSERT INTO auditor_sources VALUES(?,?,?) ON CONFLICT(owner,provider) DO UPDATE SET model=excluded.model').run(member.id,b.provider,b.model);
      else db.prepare('DELETE FROM auditor_sources WHERE owner=? AND provider=?').run(member.id,b.provider);
      send(res,200,{ok:true});return true;
    }
    if(p==='/api/auditor/config'&&req.method==='GET'){
      if(member.kind!=='agent')return send(res,403,{error:'仅插件可以读取审计员设置'}),true;
      send(res,200,db.prepare('SELECT provider,model FROM auditor_sources WHERE owner=?').all(member.id));return true;
    }
    if(p==='/api/auditor/jobs'&&req.method==='GET'){
      if(member.kind!=='agent')return send(res,403,{error:'仅插件可以读取审计任务'}),true;
      const row=db.prepare("SELECT * FROM audit_jobs WHERE owner=? AND (status='pending' OR status='claimed' AND claimed_at<?) ORDER BY message LIMIT 1").get(member.id,Date.now()-300000);
      if(!row)return send(res,200,null),true;
      const m=selectMessage(row.message);const candidates=db.prepare('SELECT r.id,r.name,r.provider FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.owner=? AND r.provider=? AND r.deleted=0 AND r.id NOT IN (SELECT role_id FROM role_blacklist WHERE room=?)').all(m.room,row.owner,row.provider,m.room).filter(r=>r.id!==(m.roleReply?.roleId||m.roleSender?.roleId));
      if(!candidates.length){
        db.prepare("UPDATE audit_jobs SET status='unavailable',token=NULL,claimed_at=NULL WHERE message=? AND owner=? AND provider=?").run(row.message,row.owner,row.provider);
        publishStatus(row.message,m.room);
        return send(res,200,null),true;
      }
      const token=randomUUID();
      db.prepare("UPDATE audit_jobs SET status='claimed',token=?,claimed_at=? WHERE message=? AND owner=? AND provider=?").run(token,Date.now(),row.message,row.owner,row.provider);
      const history=db.prepare('SELECT id FROM messages WHERE room=? AND id<=? ORDER BY id DESC LIMIT 6').all(m.room,m.id).reverse().map(x=>summarize(selectMessage(x.id)));
      const room=db.prepare('SELECT id,name FROM rooms WHERE id=?').get(m.room);
      const roomRoles=db.prepare('SELECT r.id,r.name,r.provider FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.deleted=0 ORDER BY r.name').all(m.room);
      const humans=db.prepare("SELECT id,name FROM members WHERE kind='human' AND disabled=0 ORDER BY name").all();
      const busy=db.prepare(`SELECT j.role_id AS roleId FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE m.room=? AND j.status IN ('pending','starting','running') GROUP BY j.role_id`).all(m.room).map(r=>r.roleId);
      const lastRepliers=db.prepare(`SELECT j.role_id AS roleId, MAX(m.id) AS message FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE m.room=? AND j.status='replied' GROUP BY j.role_id`).all(m.room);
      send(res,200,{message:row.message,provider:row.provider,model:row.model,token,room,humans,roomRoles,candidates,history,busy,lastRepliers});return true;
    }
    if(p==='/api/auditor/history'&&req.method==='POST'){
      if(member.kind!=='agent')return send(res,403,{error:'仅插件可以读取审计历史'}),true;
      const b=await json(req),row=db.prepare("SELECT * FROM audit_jobs WHERE message=? AND owner=? AND token=? AND status='claimed'").get(b.message,member.id,b.token);
      if(!row)return send(res,403,{error:'审计任务不存在或已过期'}),true;
      if(!Number.isSafeInteger(b.before)||b.before<1||b.before>row.message)throw Error('历史游标无效');
      const room=selectMessage(row.message).room,rows=db.prepare('SELECT id FROM messages WHERE room=? AND id<? ORDER BY id DESC LIMIT 31').all(room,b.before),hasMore=rows.length>30;
      const messages=rows.slice(0,30).reverse().map(x=>summarize(selectMessage(x.id)));
      send(res,200,{messages,hasMore,nextBefore:hasMore?messages[0]?.id:null});return true;
    }
    const routeMessage=p.match(/^\/api\/messages\/(\d+)\/route$/);
    if(routeMessage&&req.method==='POST'){
      if(member.kind!=='human')return send(res,403,{error:'只有用户可以手动派发消息'}),true;
      const id=Number(routeMessage[1]),b=await json(req);
      const message=selectMessage(id);
      if(!message)return send(res,404,{error:'消息不存在'}),true;
      if(typeof b?.roleId!=='string'||!b.roleId)throw Error('角色标识无效');
      const role=db.prepare('SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.id=? AND r.deleted=0').get(message.room,b.roleId);
      if(!role)return send(res,400,{error:'角色尚未加入当前群聊'}),true;
      const existing=sourceJobs.all(id,id).find(job=>job.role_id===role.id);
      if(existing){
        if(existing.status==='failed')return send(res,409,{error:'该角色已有失败任务，请选择其他角色'}),true;
        send(res,200,{routeStatus:statusForMessage(id),job:roles.getJob(existing.message)});return true;
      }
      if(!['failed','unavailable','partial'].includes(statusForMessage(id)))return send(res,409,{error:'当前消息无需手动派发'}),true;
      db.exec('BEGIN IMMEDIATE');let jobId;
      try{
        jobId=roles.insertAdditionalJob(id,role);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      const job=roles.getJob(jobId);
      event({type:'role-job',job});
      publishStatus(id,message.room);
      send(res,201,{routeStatus:statusForMessage(id),job});return true;
    }
    const match=p.match(/^\/api\/auditor\/jobs\/(\d+)$/);
    if(match&&req.method==='POST'){
      const b=await json(req),id=Number(match[1]);if(member.kind!=='agent')return send(res,403,{error:'仅插件可以提交判断'}),true;
      const row=db.prepare("SELECT * FROM audit_jobs WHERE message=? AND owner=? AND token=? AND status='claimed'").get(id,member.id,b.token);if(!row)return send(res,409,{error:'审计任务已过期'}),true;
      const status=complete(row,selectMessage(id),b);
      send(res,200,{status});return true;
    }
    return false;
  }
  return {enqueue,route,statusForMessage,publishStatus,pump:()=>unified.pump(candidateRoles,complete)};
}
