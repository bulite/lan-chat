import {randomUUID} from 'node:crypto';

// One lightweight classifier per plugin identity; its verdict only creates an
// ordinary role job, never grants the classifier authority to execute tools.
export function audits(db,event,selectMessage,roles){
  db.exec(`CREATE TABLE IF NOT EXISTS auditor_sources(owner TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(owner,provider));
    CREATE TABLE IF NOT EXISTS audit_jobs(message INTEGER NOT NULL,owner TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',token TEXT,claimed_at INTEGER,error TEXT,PRIMARY KEY(message,owner,provider));
    CREATE TABLE IF NOT EXISTS role_blacklist(role_id TEXT NOT NULL,owner TEXT NOT NULL,room TEXT NOT NULL,blocked_at TEXT NOT NULL,reason TEXT,PRIMARY KEY(role_id,room));`);
  const messageRoom=id=>{try{return selectMessage(id).room}catch{return undefined}};
  const summarize=x=>({id:x.id,sender:x.roleReply?.roleName||x.roleSender?.roleName||x.sender,senderRoleId:x.roleReply?.roleId||x.roleSender?.roleId||null,kind:x.kind,text:x.asDocument||x.text.length>600?`[文档，${x.text.length} 字，查看 /api/messages/${x.id}/content]`:x.text,...(x.fileId?{attachment:{description:(/\.(png|jpe?g|gif|webp|bmp)$/i.test(x.fileName)?'图片':'附件')+'：'+x.fileName,messageId:x.id,url:'/api/files/'+x.fileId}}:{})});
  function enqueue(messageId,room,roleId,text,replyTo,fileId){
    if(roleId||(!text&&!fileId))return;
    // 规则前置：人类直接回复某条角色消息时，不调审计，直接派给该角色。
    if(Number.isSafeInteger(replyTo)){
      const sent=db.prepare('SELECT role_id AS roleId FROM role_messages WHERE message=?').get(replyTo);
      if(sent){
        const role=db.prepare('SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort FROM roles r LEFT JOIN room_roles rr ON rr.role_id=r.id AND rr.room=? WHERE r.id=? AND r.deleted=0').get(room,sent.roleId);
        if(role){role.autoRouted=true;roles.insertAdditionalJob(messageId,role);return;}
      }
    }
    // 连续对话：上一条与本条间隔 >= 1 小时视为新会话，解除本群所有角色黑名单。
    const prev=db.prepare('SELECT created FROM messages WHERE room=? AND id<? ORDER BY id DESC LIMIT 1').get(room,messageId);
    if(!prev||Date.now()-Date.parse(prev.created)>=3600000)db.prepare('DELETE FROM role_blacklist WHERE room=?').run(room);
    db.prepare(`INSERT OR IGNORE INTO audit_jobs(message,owner,provider,model)
      SELECT ?,s.owner,s.provider,s.model FROM auditor_sources s WHERE EXISTS
      (SELECT 1 FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.owner=s.owner AND r.provider=s.provider AND r.deleted=0)`).run(messageId,room);
  }
  async function route(req,res,url,member,{send,json}){
    const p=url.pathname;
    if(p==='/api/managed-auditor'&&['GET','POST'].includes(req.method)){
      if(req.headers.origin!=='http://10.0.8.54:3080'||member.kind!=='human')return send(res,403,{error:'请在 DSH 插件中管理审计员'}),true;
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
      const token=randomUUID();db.prepare("UPDATE audit_jobs SET status='claimed',token=?,claimed_at=? WHERE message=? AND owner=? AND provider=?").run(token,Date.now(),row.message,row.owner,row.provider);
      const m=selectMessage(row.message);const candidates=db.prepare('SELECT r.id,r.name,r.provider FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.owner=? AND r.provider=? AND r.deleted=0 AND r.id NOT IN (SELECT role_id FROM role_blacklist WHERE room=?)').all(m.room,row.owner,row.provider,m.room).filter(r=>r.id!==(m.roleReply?.roleId||m.roleSender?.roleId));
      if(!candidates.length){
        // 没有可用角色：发一条群内系统提示，并把审计任务标为 notified，避免反复重试与刷屏。
        const cur=db.prepare('SELECT status FROM audit_jobs WHERE message=? AND owner=? AND provider=?').get(row.message,row.owner,row.provider);
        const already=db.prepare("SELECT 1 FROM audit_jobs WHERE message=? AND status='notified' LIMIT 1").get(row.message);
        const human=selectMessage(row.message)?.kind==='human';
        // 只有整个群都没有可用角色时才提示；某个 provider 无候选（如 codex 全黑名单）不该刷屏。
        const anyCandidate=db.prepare('SELECT 1 FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.deleted=0 AND r.id NOT IN (SELECT role_id FROM role_blacklist WHERE room=?) LIMIT 1').get(m.room,m.room);
        if(cur&&cur.status!=='notified'&&!already&&human&&!anyCandidate){
          const sys=db.prepare("SELECT id FROM members WHERE kind='agent' AND token IS NOT NULL ORDER BY name LIMIT 1").get();
          if(sys){
            const nowIso=new Date().toISOString();
            const ins=db.prepare('INSERT INTO messages(room,member,text,file,created) VALUES(?,?,?,NULL,?)').run(m.room,sys.id,`⚠️ 系统提示：当前没有可用角色（全部处于失败冷却），消息 #${row.message} 暂未投递，冷却结束后会重新参与派发。`,nowIso);
            const id=Number(ins.lastInsertRowid);
            db.prepare('INSERT INTO message_meta(message,kind,priority,reply_to,client_id,sender,task_id,as_document,role_all,role_target) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'message','normal',null,null,sys.id,null,0,0,null);
            event({type:'message',message:id,room:m.room});
          }
          db.prepare("UPDATE audit_jobs SET status='notified',token=NULL,claimed_at=NULL WHERE message=? AND owner=? AND provider=?").run(row.message,row.owner,row.provider);
        }
        return send(res,200,null),true;
      }
      const history=db.prepare('SELECT id FROM messages WHERE room=? AND id<=? ORDER BY id DESC LIMIT 6').all(m.room,m.id).reverse().map(x=>summarize(selectMessage(x.id)));
      const room=db.prepare('SELECT id,name FROM rooms WHERE id=?').get(m.room);
      const roomRoles=db.prepare('SELECT r.id,r.name,r.provider FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.deleted=0 ORDER BY r.name').all(m.room);
      const humans=db.prepare("SELECT id,name FROM members WHERE kind='human' AND disabled=0 ORDER BY name").all();
      const busy=db.prepare(`SELECT j.role_id AS roleId FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE m.room=? AND j.status IN ('pending','starting','running') GROUP BY j.role_id`).all(row.message&&selectMessage(row.message).room).map(r=>r.roleId);
      const lastRepliers=db.prepare(`SELECT j.role_id AS roleId, MAX(m.id) AS message FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE m.room=? AND j.status='replied' GROUP BY j.role_id`).all(messageRoom(row.message));
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
    const match=p.match(/^\/api\/auditor\/jobs\/(\d+)$/);
    if(match&&req.method==='POST'){
      const b=await json(req),id=Number(match[1]);if(member.kind!=='agent')return send(res,403,{error:'仅插件可以提交判断'}),true;
      const row=db.prepare("SELECT * FROM audit_jobs WHERE message=? AND owner=? AND token=? AND status='claimed'").get(id,member.id,b.token);if(!row)return send(res,409,{error:'审计任务已过期'}),true;
      const message=selectMessage(id);let status='ignored',created=[];
      db.exec('BEGIN IMMEDIATE');try{
        const candidates=db.prepare('SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.owner=? AND r.provider=? AND r.deleted=0 AND r.id NOT IN (SELECT role_id FROM role_blacklist WHERE room=?)').all(message.room,member.id,row.provider,message.room).filter(r=>r.id!==(message.roleReply?.roleId||message.roleSender?.roleId));
        const blacklisted=new Set(db.prepare('SELECT role_id FROM role_blacklist WHERE room=?').all(message.room).map(x=>x.role_id));
        let ids=b.roleIds??(b.roleId==null?[]:[b.roleId]);
        if(b.error&&message.kind==='human')ids=candidates.map(r=>r.id);
        else if(b.error)status='failed';
        ids=ids.filter(x=>!blacklisted.has(x));
        if(!Array.isArray(ids)||ids.length>candidates.length||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length)throw Error('审计员选择的角色列表无效');
        for(const roleId of ids){
          const role=candidates.find(r=>r.id===roleId);if(!role)throw Error('审计员选择了无效的角色');
            const last=db.prepare(`SELECT j.message,j.session_id FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE m.room=? AND j.role_id=? AND j.session_id IS NOT NULL AND j.status IN ('running','replied') ORDER BY m.id DESC LIMIT 1`).get(message.room,role.id);
            if(last){role.sessionId=last.session_id;role.continuationOf=last.message;}
            role.autoRouted=true;const jobId=roles.insertAdditionalJob(id,role);if(jobId!==null){created.push(jobId);status='routed';}
        }
        if(!db.prepare('PRAGMA table_info(audit_jobs)').all().some(c=>c.name==='reason'))db.exec('ALTER TABLE audit_jobs ADD COLUMN reason TEXT');
        db.prepare('UPDATE audit_jobs SET status=?,error=?,reason=? WHERE message=? AND owner=? AND provider=?').run(status,b.error?String(b.error).slice(0,500):null,b.reason?String(b.reason).slice(0,500):null,id,member.id,row.provider);db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      for(const jobId of created)event({type:'role-job',job:roles.getJob(jobId)});
      send(res,200,{status});return true;
    }
    return false;
  }
  return {enqueue,route};
}
