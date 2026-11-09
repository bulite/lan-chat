import {randomUUID} from 'node:crypto';

// Role jobs are separate from directed inbox deliveries: claiming a job must
// never change the meaning of an existing inbox receipt.
export function roles(db, event, selectMessage) {
  db.exec(`CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL,
    name TEXT NOT NULL, model TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS roles_owner ON roles(owner,deleted);
  CREATE TABLE IF NOT EXISTS room_roles (
    room TEXT NOT NULL, role_id TEXT NOT NULL, effort TEXT NOT NULL,
    PRIMARY KEY(room,role_id)
  );
  CREATE TABLE IF NOT EXISTS role_sources (
    owner TEXT NOT NULL, provider TEXT NOT NULL, models TEXT NOT NULL,
    updated TEXT NOT NULL, PRIMARY KEY(owner,provider)
  );
  CREATE TABLE IF NOT EXISTS role_jobs (
    message INTEGER PRIMARY KEY, role_id TEXT NOT NULL, owner TEXT NOT NULL,
    provider TEXT NOT NULL, role_name TEXT NOT NULL, model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, error TEXT,
    reply_message INTEGER, updated TEXT NOT NULL, claim_token TEXT, continuation_of INTEGER
  );
  CREATE TABLE IF NOT EXISTS role_job_origins(job_id INTEGER PRIMARY KEY,original_message INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS role_messages(message INTEGER PRIMARY KEY,role_id TEXT NOT NULL,role_name TEXT NOT NULL,provider TEXT NOT NULL,source_job INTEGER NOT NULL,target_role_id TEXT);
  CREATE TABLE IF NOT EXISTS role_decisions(source_job INTEGER PRIMARY KEY,reason TEXT);
  CREATE TABLE IF NOT EXISTS role_blacklist(role_id TEXT NOT NULL,owner TEXT NOT NULL,room TEXT NOT NULL,blocked_at TEXT NOT NULL,reason TEXT,PRIMARY KEY(role_id,room));
  CREATE INDEX IF NOT EXISTS role_job_origins_message ON role_job_origins(original_message);
  CREATE INDEX IF NOT EXISTS role_jobs_owner ON role_jobs(owner,status,message);`);
  if(!db.prepare('PRAGMA table_info(role_jobs)').all().some(c=>c.name==='claim_token'))db.exec('ALTER TABLE role_jobs ADD COLUMN claim_token TEXT');
  if(!db.prepare('PRAGMA table_info(role_jobs)').all().some(c=>c.name==='continuation_of'))db.exec('ALTER TABLE role_jobs ADD COLUMN continuation_of INTEGER');
  if(!db.prepare('PRAGMA table_info(role_jobs)').all().some(c=>c.name==='effort'))db.exec('ALTER TABLE role_jobs ADD COLUMN effort TEXT');
  if(!db.prepare('PRAGMA table_info(role_jobs)').all().some(c=>c.name==='auto_routed'))db.exec('ALTER TABLE role_jobs ADD COLUMN auto_routed INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(role_jobs)').all().some(c=>c.name==='steer_parent'))db.exec('ALTER TABLE role_jobs ADD COLUMN steer_parent INTEGER');
  if(!db.prepare('PRAGMA table_info(role_messages)').all().some(c=>c.name==='target_role_id'))db.exec('ALTER TABLE role_messages ADD COLUMN target_role_id TEXT');
  const active=db.prepare('SELECT id,owner,provider,name,model FROM roles WHERE id=? AND deleted=0');
  const job=db.prepare(`SELECT message,COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=role_jobs.message),message) AS sourceMessage,role_id AS roleId,provider,role_name AS roleName,
    model,status,session_id AS sessionId,error,reply_message AS replyMessage,continuation_of AS continuationOf,steer_parent AS steerParent,effort,updated
    FROM role_jobs WHERE message=?`);
  const decorate=m=>{
    if(!m)return m;
    const ids=db.prepare('SELECT message FROM role_jobs WHERE message=? OR message IN (SELECT job_id FROM role_job_origins WHERE original_message=?) ORDER BY message').all(m.id,m.id);
    const jobs=ids.map(x=>job.get(x.message));if(jobs.length){m.roleJob=jobs[0];if(jobs.length>1||m.roleAll)m.roleJobs=jobs;}
    const reply=db.prepare('SELECT COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=role_jobs.message),message) AS message,role_id AS roleId,provider,role_name AS roleName FROM role_jobs WHERE reply_message=?').get(m.id);
    if(reply)m.roleReply=reply;
    const speaker=db.prepare('SELECT role_id AS roleId,role_name AS roleName,provider,source_job AS sourceJob FROM role_messages WHERE message=?').get(m.id);
    if(speaker)m.roleSender=speaker;
    return m;
  };
  function validateMention(b,member) {
    if(b.roleId==null)return null;
    if(member.kind!=='human')throw Error('只有用户消息可以触发角色');
    if(typeof b.roleId!=='string')throw Error('角色标识无效');
    if(b.roleId==='__all__'){
      if(b.replyTo!=null)throw Error('@全体不能与继续单个角色的会话同时使用');
      const all=db.prepare('SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.deleted=0 ORDER BY r.id').all(b.room||'general');
      if(!all.length)throw Error('当前群聊没有角色，请先添加角色');
      return all.map(role=>({...role,autoRouted:true}));
    }
    const role=active.get(b.roleId);
    if(!role)throw Error('角色不存在或已删除');
    const membership=db.prepare('SELECT effort FROM room_roles WHERE room=? AND role_id=?').get(b.room||'general',role.id);
    if(!membership)throw Error('该角色尚未加入当前群聊');
    role.effort=membership.effort;
    if(b.replyTo==null)return role;
    const sent=db.prepare('SELECT source_job,role_id FROM role_messages WHERE message=?').get(b.replyTo);
    if(sent){
      if(sent.role_id!==role.id)throw Error('回复的消息属于其他角色');
      const previous=db.prepare('SELECT * FROM role_jobs WHERE message=?').get(sent.source_job);
      if(!previous||!['running','replied'].includes(previous.status)||!previous.session_id)throw Error('原角色会话尚未启动，暂时不能继续');
      return {...role,sessionId:previous.session_id,continuationOf:previous.message};
    }
    const previous=db.prepare('SELECT * FROM role_jobs WHERE role_id=? AND (message=? OR reply_message=? OR message IN (SELECT job_id FROM role_job_origins WHERE original_message=?))').get(role.id,b.replyTo,b.replyTo,b.replyTo);
    // A role mention in reply to an unrelated message starts a new session.
    if(!previous){
      if(db.prepare('SELECT 1 FROM role_jobs WHERE message=? OR reply_message=? OR message IN (SELECT job_id FROM role_job_origins WHERE original_message=?)').get(b.replyTo,b.replyTo,b.replyTo))throw Error('回复的消息属于其他角色');
      return role;
    }
    if(previous.role_id!==role.id)throw Error('回复的消息属于其他角色');
    if(!['running','replied'].includes(previous.status)||!previous.session_id)throw Error('原角色会话尚未启动，暂时不能继续');
    return {...role,sessionId:previous.session_id,continuationOf:previous.message};
  }
  function insertJob(id,role) {
    if(Array.isArray(role)){
      role.forEach((item,index)=>{let jobId=id;if(index){jobId=Number(db.prepare('SELECT COALESCE(MAX(job_id),1000000000000)+1 AS id FROM role_job_origins').get().id);db.prepare('INSERT INTO role_job_origins(job_id,original_message) VALUES(?,?)').run(jobId,id);}insertJob(jobId,item);});return;
    }
    if(role)db.prepare(`INSERT INTO role_jobs(message,role_id,owner,provider,role_name,model,updated,session_id,continuation_of,effort,auto_routed)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,role.id,role.owner,role.provider,role.name,role.model,new Date().toISOString(),role.sessionId??null,role.continuationOf??null,role.effort??null,role.autoRouted?1:0);
  }
  function insertAdditionalJob(source,role){
    const existing=db.prepare('SELECT message FROM role_jobs WHERE role_id=? AND (message=? OR message IN (SELECT job_id FROM role_job_origins WHERE original_message=?))').get(role.id,source,source);
    if(existing)return null;
    let id=source;
    if(db.prepare('SELECT 1 FROM role_jobs WHERE message=?').get(source)){
      id=Number(db.prepare('SELECT COALESCE(MAX(job_id),1000000000000)+1 AS id FROM role_job_origins').get().id);
      db.prepare('INSERT INTO role_job_origins(job_id,original_message) VALUES(?,?)').run(id,source);
    }
    insertJob(id,role);return id;
  }
  const text=(value,label,max)=>{
    if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw Error(label+'无效');
    return value.trim();
  };
  const owned=(id,member)=>db.prepare('SELECT * FROM roles WHERE id=? AND owner=? AND deleted=0').get(id,member.id);
  async function route(req,res,url,member,{send,json,createReply}) {
    const p=url.pathname;
    const roomMatch=p.match(/^\/api\/rooms\/([^/]+)\/roles(?:\/([^/]+))?$/);
    if(roomMatch){
      const room=decodeURIComponent(roomMatch[1]),roleId=roomMatch[2]&&decodeURIComponent(roomMatch[2]);
      if(!db.prepare('SELECT id FROM rooms WHERE id=?').get(room))return send(res,404,{error:'群聊不存在'}),true;
      if(req.method==='GET'&&!roleId){send(res,200,db.prepare('SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.deleted=0 ORDER BY r.name,r.id').all(room));return true;}
      if(member.kind!=='human')return send(res,403,{error:'只有用户可以管理群聊角色'}),true;
      if(req.method==='POST'&&!roleId){
        const b=await json(req),role=active.get(b.roleId);if(!role)throw Error('角色不存在或已删除');
        if(typeof b.effort!=='string'||!b.effort.trim()||b.effort.length>100)throw Error('思考等级无效');
        if(b.effort!=='default'){
          const source=db.prepare('SELECT models FROM role_sources WHERE owner=? AND provider=?').get(role.owner,role.provider);
          const model=source&&JSON.parse(source.models).find(m=>m.id===role.model);
          if(!model?.efforts?.includes(b.effort))throw Error('该模型不支持所选思考等级，或插件尚未提供能力列表');
        }
        db.prepare('INSERT INTO room_roles(room,role_id,effort) VALUES(?,?,?) ON CONFLICT(room,role_id) DO UPDATE SET effort=excluded.effort').run(room,role.id,b.effort);
        event({type:'room-roles',room});send(res,200,{ok:true});return true;
      }
      if(req.method==='DELETE'&&roleId){db.prepare('DELETE FROM room_roles WHERE room=? AND role_id=?').run(room,roleId);event({type:'room-roles',room});send(res,200,{ok:true});return true;}
    }
    if(p==='/api/role-sources'&&req.method==='GET'){
      if(req.headers.origin!=='http://10.0.8.54:3080')return send(res,403,{error:'请在 DSH 插件中管理角色'}),true;
      const rows=db.prepare('SELECT owner,provider,models,updated FROM role_sources ORDER BY provider,owner').all();
      send(res,200,rows.map(r=>({...r,models:JSON.parse(r.models)})));return true;
    }
    if(p==='/api/role-sources'&&req.method==='POST'){
      if(member.kind!=='agent')return send(res,403,{error:'只有插件可以发布模型列表'}),true;
      const b=await json(req);if(!['codex','dsh'].includes(b.provider)||!Array.isArray(b.models)||b.models.length>500)throw Error('模型列表无效');
      const seen=new Set(),models=b.models.map(m=>({id:text(m.id,'模型标识',200),name:text(m.name,'模型名称',200),efforts:Array.isArray(m.efforts)?m.efforts.map(e=>text(e,'思考等级',100)):[]}));
      if(models.some(m=>seen.has(m.id)||!seen.add(m.id)))throw Error('模型列表包含重复项');
      db.prepare('INSERT INTO role_sources(owner,provider,models,updated) VALUES(?,?,?,?) ON CONFLICT(owner,provider) DO UPDATE SET models=excluded.models,updated=excluded.updated').run(member.id,b.provider,JSON.stringify(models),new Date().toISOString());
      event({type:'role-sources'});send(res,200,{ok:true});return true;
    }
    if(p==='/api/role-capabilities'&&req.method==='GET'){
      send(res,200,db.prepare('SELECT owner,provider,models,updated FROM role_sources').all().map(r=>({...r,models:JSON.parse(r.models)})));return true;
    }
    if(p==='/api/managed-roles'&&req.method==='POST'){
      if(req.headers.origin!=='http://10.0.8.54:3080')return send(res,403,{error:'请在 DSH 插件中管理角色'}),true;
      if(member.kind!=='human')return send(res,403,{error:'仅用户可通过页面管理角色'}),true;
      const b=await json(req),name=text(b.name,'角色名称',60),model=text(b.model,'模型',200);
      if(b.provider!=='dsh')throw Error('Codex 角色请在 Codex 插件中管理');
      const source=db.prepare('SELECT * FROM role_sources WHERE owner=? AND provider=?').get(b.owner,b.provider);
      if(!source||!JSON.parse(source.models).some(m=>m.id===model))throw Error('请从对应插件提供的模型列表中选择');
      const role={id:randomUUID(),owner:source.owner,provider:source.provider,name,model};
      db.prepare('INSERT INTO roles(id,owner,provider,name,model) VALUES(?,?,?,?,?)').run(role.id,role.owner,role.provider,role.name,role.model);
      event({type:'roles'});send(res,201,role);return true;
    }
    const managed=p.match(/^\/api\/managed-roles\/([^/]+)$/);
    if(managed&&(req.method==='PATCH'||req.method==='DELETE')){
      if(req.headers.origin!=='http://10.0.8.54:3080')return send(res,403,{error:'请在 DSH 插件中管理角色'}),true;
      if(member.kind!=='human')return send(res,403,{error:'仅用户可通过页面管理角色'}),true;
      const id=decodeURIComponent(managed[1]),role=active.get(id);if(!role)return send(res,404,{error:'角色不存在'}),true;
      if(role.provider!=='dsh')return send(res,403,{error:'Codex 角色请在 Codex 插件中管理'}),true;
      if(req.method==='DELETE')db.prepare('UPDATE roles SET deleted=1 WHERE id=?').run(id);
      else{
        const b=await json(req),name=text(b.name,'角色名称',60),model=text(b.model,'模型',200);
        const source=db.prepare('SELECT models FROM role_sources WHERE owner=? AND provider=?').get(role.owner,role.provider);
        if(!source||!JSON.parse(source.models).some(m=>m.id===model))throw Error('请从对应插件提供的模型列表中选择');
        db.prepare('UPDATE roles SET name=?,model=? WHERE id=?').run(name,model,id);
      }
      event({type:'roles'});send(res,200,{ok:true});return true;
    }
    if(p==='/api/roles'&&req.method==='GET') {
      send(res,200,db.prepare('SELECT id,owner,provider,name,model FROM roles WHERE deleted=0 ORDER BY name,id').all());return true;
    }
    if(p==='/api/roles'&&req.method==='POST') {
      if(member.kind!=='agent')return send(res,403,{error:'只有插件身份可以管理角色'}),true;
      const b=await json(req),name=text(b.name,'角色名称',60),model=text(b.model,'模型',200);
      if(!['codex','dsh'].includes(b.provider))throw Error('插件类型无效');
      const role={id:randomUUID(),owner:member.id,provider:b.provider,name,model};
      db.prepare('INSERT INTO roles(id,owner,provider,name,model) VALUES(?,?,?,?,?)').run(role.id,role.owner,role.provider,role.name,role.model);
      event({type:'roles'});send(res,201,role);return true;
    }
    const match=p.match(/^\/api\/roles\/([^/]+)$/);
    if(match&&(req.method==='PATCH'||req.method==='DELETE')) {
      const id=decodeURIComponent(match[1]);if(!owned(id,member))return send(res,404,{error:'角色不存在'}),true;
      if(req.method==='DELETE')db.prepare('UPDATE roles SET deleted=1 WHERE id=?').run(id);
      else {const b=await json(req),name=text(b.name,'角色名称',60),model=text(b.model,'模型',200);db.prepare('UPDATE roles SET name=?,model=? WHERE id=?').run(name,model,id);}
      event({type:'roles'});send(res,200,{ok:true});return true;
    }
    if(p==='/api/role-jobs'&&req.method==='GET') {
      if(member.kind!=='agent')return send(res,403,{error:'仅插件身份可读取任务'}),true;
      const rows=db.prepare(`SELECT message FROM role_jobs WHERE owner=? AND status IN ('pending','starting','running') ORDER BY message LIMIT 100`).all(member.id);
      send(res,200,rows.map(({message})=>{const value=job.get(message);return {...value,messageData:selectMessage(value.sourceMessage)};}));return true;
    }
    if(p==='/api/role-blacklist/reset'&&req.method==='POST'){
      const n=db.prepare('DELETE FROM role_blacklist WHERE owner=?').run(member.id).changes;
      send(res,200,{ok:true,cleared:n});return true;
    }
    const jm=p.match(/^\/api\/role-jobs\/(\d+)\/(claim|steer-claim|steer-release|waiting|started|fail|complete)$/);
    if(jm&&req.method==='POST') {
      const id=Number(jm[1]),action=jm[2];
      const b=await json(req,action==='complete'?1024*1024:undefined),now=new Date().toISOString();
      // Read after consuming the asynchronous request body: another request may
      // have completed the job while this request was still being received.
      const row=db.prepare('SELECT * FROM role_jobs WHERE message=? AND owner=?').get(id,member.id);
      if(!row||member.kind!=='agent')return send(res,404,{error:'任务不存在'}),true;
      if(action==='steer-claim'){
        const token=text(b.claimToken,'领取标识',200),source=job.get(id).sourceMessage;
        if(row.status==='pending'){
          const parents=db.prepare("SELECT j.message,j.session_id FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE j.owner=? AND j.role_id=? AND j.status='running' AND j.steer_parent IS NULL AND j.session_id IS NOT NULL AND m.room=(SELECT room FROM messages WHERE id=?) AND m.id<?").all(member.id,row.role_id,source,source);
          if(parents.length===1)db.prepare("UPDATE role_jobs SET status='starting',claim_token=?,session_id=?,continuation_of=?,steer_parent=?,updated=? WHERE message=? AND status='pending'").run(token,parents[0].session_id,parents[0].message,parents[0].message,now,id);
        }
        const current=db.prepare('SELECT claim_token,status,steer_parent FROM role_jobs WHERE message=?').get(id),value=job.get(id);
        if(current.steer_parent)event({type:'role-job',job:value});send(res,200,{...value,claimed:!!current.steer_parent&&['starting','running'].includes(current.status)&&current.claim_token===token});return true;
      } else if(action==='steer-release'){
        if(!row.steer_parent||row.claim_token!==b.claimToken||row.status!=='starting')throw Error('引导任务状态不允许退回队列');
        db.prepare("UPDATE role_jobs SET status='pending',claim_token=NULL,steer_parent=NULL,updated=? WHERE message=?").run(now,id);
        const value=job.get(id);event({type:'role-job',job:value});send(res,200,value);return true;
      } else if(action==='claim') {
        const token=text(b.claimToken,'领取标识',200);
        const source=job.get(id).sourceMessage;
        // Follow-ups sharing a session are processed in message order. They
        // must never steer an earlier, still-running turn.
        const busy=row.auto_routed?db.prepare("SELECT 1 FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE j.owner=? AND j.role_id=? AND m.room=(SELECT room FROM messages WHERE id=?) AND m.id<? AND j.status IN ('pending','starting','running') LIMIT 1").get(member.id,row.role_id,source,source):row.session_id&&db.prepare("SELECT 1 FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE j.owner=? AND j.session_id=? AND m.id<? AND j.status IN ('pending','starting','running') LIMIT 1").get(member.id,row.session_id,source);
        if(row.status==='pending'&&!busy&&row.auto_routed){
          const last=db.prepare("SELECT j.message,j.session_id FROM role_jobs j JOIN messages m ON m.id=COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=j.message),j.message) WHERE j.owner=? AND j.role_id=? AND m.room=(SELECT room FROM messages WHERE id=?) AND m.id<? AND j.status='replied' AND j.session_id IS NOT NULL ORDER BY m.id DESC LIMIT 1").get(member.id,row.role_id,source,source);
          if(last)db.prepare('UPDATE role_jobs SET session_id=?,continuation_of=? WHERE message=?').run(last.session_id,last.message,id);
        }
        if(row.status==='pending'&&!busy)db.prepare("UPDATE role_jobs SET status='starting',claim_token=?,updated=? WHERE message=? AND status='pending'").run(token,now,id);
        const current=db.prepare('SELECT claim_token,status FROM role_jobs WHERE message=?').get(id);
        const value=job.get(id);event({type:'role-job',job:value});send(res,200,{...value,claimed:['starting','running'].includes(current.status)&&current.claim_token===token});return true;
      } else if(action==='waiting'){
        if(!row.claim_token||row.claim_token!==b.claimToken)return send(res,409,{error:'任务已由其他执行器领取'}),true;
        if(!['starting','running'].includes(row.status))throw Error('任务状态不允许更新等待原因');
        const reason=text(b.reason,'等待原因',300);
        if(row.error!==reason){db.prepare('UPDATE role_jobs SET error=?,updated=? WHERE message=?').run(reason,now,id);event({type:'role-job',job:job.get(id)});}
        send(res,200,job.get(id));return true;
      } else if(action==='started') {
        if(!row.claim_token||row.claim_token!==b.claimToken)return send(res,409,{error:'任务已由其他执行器领取'}),true;
        const session=text(b.sessionId,'会话标识',200);
        if(!['starting','running'].includes(row.status)||row.session_id&&row.session_id!==session)throw Error('任务状态或会话标识不匹配');
        if(row.status==='running'&&!row.error)return send(res,200,job.get(id)),true;
        db.prepare("UPDATE role_jobs SET status='running',session_id=?,error=NULL,updated=? WHERE message=?").run(session,now,id);
      } else if(action==='complete') {
        if(!row.claim_token||row.claim_token!==b.claimToken)return send(res,409,{error:'任务已由其他执行器领取'}),true;
        if(row.status==='replied')return send(res,200,{job:job.get(id),message:selectMessage(row.reply_message)}),true;
        if(row.status==='dismissed'&&b.skipped===true)return send(res,200,{job:job.get(id)}),true;
        if(row.status!=='running')throw Error('任务尚未开始或已结束');
        if(b.skipped===true){
          if(!db.prepare('SELECT 1 FROM role_decisions WHERE source_job=?').get(id))throw Error('角色尚未确认无需回复');
          db.prepare("UPDATE role_jobs SET status='dismissed',updated=? WHERE message=? AND status='running'").run(now,id);
          const value=job.get(id);event({type:'role-job',job:value});send(res,200,{job:value});return true;
        }
        if(b.sentMessageId!=null){
          if(!Number.isSafeInteger(b.sentMessageId)||!db.prepare('SELECT 1 FROM role_messages WHERE message=? AND source_job=?').get(b.sentMessageId,id))throw Error('消息不属于本角色任务');
          db.prepare("UPDATE role_jobs SET status='replied',reply_message=?,updated=? WHERE message=? AND status='running'").run(b.sentMessageId,now,id);
          const value=job.get(id);event({type:'role-job',job:value});send(res,200,{job:value,message:selectMessage(b.sentMessageId)});return true;
        }
        const reply=text(b.text,'回复',100000);
        const message=createReply(row,reply),value=job.get(id);
        event({type:'role-job',job:value});send(res,200,{job:value,message});return true;
      } else {
        if(!row.claim_token||row.claim_token!==b.claimToken)return send(res,409,{error:'任务已由其他执行器领取'}),true;
        if(row.status==='failed')return send(res,200,job.get(id)),true;
        if(!['starting','running'].includes(row.status))throw Error('任务状态不允许标记失败');
        const reason=text(b.error,'错误原因',1000);
        const session=b.sessionId==null?row.session_id:text(b.sessionId,'会话标识',200);
        if(row.session_id&&session!==row.session_id)throw Error('任务会话标识不匹配');
        db.prepare("UPDATE role_jobs SET status='failed',error=?,session_id=?,updated=? WHERE message=?").run(reason,session,now,id);
        // 失败即拉黑：连续对话中不再向他投递；1 小时无对话后由 audits.enqueue 解除。
        // 附加任务(role_job_origins)的 message 不是真实消息 id，必须回溯到原始消息再取 room。
        const origin=db.prepare('SELECT COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=?),?) AS id').get(id,row.message).id;
        const failRoom=db.prepare('SELECT room FROM messages WHERE id=?').get(origin)?.room;
        // 只有"真失败"才拉黑：配额/限流/模型不可用等。会话绑定、重启、未回复这类软失败一律不拉黑。
        const hard=/usage limit|quota|rate limit|429|401|invalid.?api.?key|额度|模型.{0,6}(不可用|不存在|未启用)|model.{0,20}(not available|unavailable|not found)/i.test(reason);
        if(failRoom&&hard){
          db.prepare("INSERT INTO role_blacklist(role_id,owner,room,blocked_at,reason) VALUES(?,?,?,?,?) ON CONFLICT(role_id,room) DO UPDATE SET blocked_at=excluded.blocked_at,reason=excluded.reason").run(row.role_id,row.owner,failRoom,now,reason.slice(0,500));
          // 把原始消息重新放回审计队列，让其他角色接（已被拉黑的不在候选里）。
          db.prepare("UPDATE audit_jobs SET status='pending',token=NULL,claimed_at=NULL,error=NULL WHERE message=? AND status='routed'").run(origin);
          db.prepare(`INSERT OR IGNORE INTO audit_jobs(message,owner,provider,model)
            SELECT ?,s.owner,s.provider,s.model FROM auditor_sources s WHERE EXISTS
            (SELECT 1 FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.owner=s.owner AND r.provider=s.provider AND r.deleted=0)`).run(origin,failRoom);
        }
      }
      const value=job.get(id);event({type:'role-job',job:value});send(res,200,value);return true;
    }
    return false;
  }
  return {decorate,validateMention,insertJob,insertAdditionalJob,getJob:id=>job.get(id),route};
}
