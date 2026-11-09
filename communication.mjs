const ranks = {pending:0, delivered:1, read:2, processed:3, dismissed:3};
export function communication(db, select, event, roleSupport, enqueueAudit) {
  db.exec(`CREATE TABLE IF NOT EXISTS message_meta(message INTEGER PRIMARY KEY, kind TEXT NOT NULL, priority TEXT NOT NULL, reply_to INTEGER, client_id TEXT, sender TEXT NOT NULL, task_id TEXT, UNIQUE(sender,client_id));
    CREATE TABLE IF NOT EXISTS deliveries(message INTEGER NOT NULL,recipient TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',updated TEXT NOT NULL,PRIMARY KEY(message,recipient));
    CREATE INDEX IF NOT EXISTS deliveries_recipient ON deliveries(recipient,status,message);
    CREATE TABLE IF NOT EXISTS presence(member TEXT PRIMARY KEY,state TEXT NOT NULL,session TEXT,updated TEXT NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(message_meta)').all().some(c=>c.name==='as_document'))db.exec('ALTER TABLE message_meta ADD COLUMN as_document INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(message_meta)').all().some(c=>c.name==='role_all'))db.exec('ALTER TABLE message_meta ADD COLUMN role_all INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(message_meta)').all().some(c=>c.name==='role_target')){
    db.exec("ALTER TABLE message_meta ADD COLUMN role_target TEXT; UPDATE message_meta SET role_target=CASE WHEN role_all=1 THEN '__all__' ELSE (SELECT role_id FROM role_jobs WHERE role_jobs.message=message_meta.message AND auto_routed=0) END");
  }
  const meta=db.prepare('SELECT kind AS messageKind,priority,reply_to AS replyTo,task_id AS taskId,as_document AS asDocument,role_all AS roleAll,role_target AS roleTarget FROM message_meta WHERE message=?');
  const receipts=db.prepare('SELECT d.recipient,p.name,d.status,d.updated FROM deliveries d JOIN members p ON p.id=d.recipient WHERE message=?');
  const decorate=m=>m&&roleSupport.decorate({...m,...(meta.get(m.id)||{messageKind:'message',priority:'normal'}),recipients:receipts.all(m.id)});
  function validate(b,member) {
    const recipients=b.recipients??[];
    if(!Array.isArray(recipients)||recipients.length>50||recipients.some(id=>typeof id!=='string'))throw Error('recipients 必须是成员 ID 数组（最多 50 个）');
    const ids=[...new Set(recipients)].filter(id=>id!==member.id);
    if(ids.some(id=>!db.prepare('SELECT id FROM members WHERE id=? AND disabled=0').get(id)))throw Error('接收成员不存在');
    const kind=b.kind||'message',priority=b.priority||'normal';
    if(!['message','request','result'].includes(kind)||!['normal','important','urgent'].includes(priority))throw Error('消息类型或优先级无效');
    if(b.replyTo!=null&&(!Number.isSafeInteger(b.replyTo)||!db.prepare('SELECT id FROM messages WHERE id=? AND room=?').get(b.replyTo,b.room||'general')))throw Error('回复的消息不在当前群聊');
    if(b.clientMessageId!=null&&(typeof b.clientMessageId!=='string'||!b.clientMessageId.length||b.clientMessageId.length>128))throw Error('clientMessageId 无效');
    if(b.taskId!=null&&(typeof b.taskId!=='string'||b.taskId.length>128))throw Error('taskId 无效');
    if(b.asDocument!=null&&typeof b.asDocument!=='boolean')throw Error('消息展示方式无效');
    return {ids,kind,priority};
  }
  function create(b,member,text,onInsert) {
    const v=validate(b,member);
    if(b.clientMessageId){const old=db.prepare(select+' JOIN message_meta mm ON mm.message=m.id WHERE mm.sender=? AND mm.client_id=?').get(member.id,b.clientMessageId);if(old){const result=decorate(old);if(old.text!==text||old.room!==(b.room||'general')||old.fileId!==(b.fileId||null)||result.messageKind!==v.kind||result.priority!==v.priority||result.replyTo!==(b.replyTo??null)||result.taskId!==(b.taskId??null)||Boolean(result.asDocument)!==Boolean(b.asDocument)||(result.roleTarget??null)!==(b.roleId??null)||JSON.stringify(result.recipients.map(r=>r.recipient).sort())!==JSON.stringify(v.ids.sort()))throw Error('clientMessageId 已用于不同消息');return {message:result,duplicate:true};}}
    const role=roleSupport.validateMention(b,member);
    const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');let id;
    try{const r=db.prepare('INSERT INTO messages(room,member,text,file,created) VALUES(?,?,?,?,?)').run(b.room||'general',member.id,text,b.fileId||null,now);id=Number(r.lastInsertRowid);
      db.prepare('INSERT INTO message_meta(message,kind,priority,reply_to,client_id,sender,task_id,as_document,role_all,role_target) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,v.kind,v.priority,b.replyTo??null,b.clientMessageId??null,member.id,b.taskId??null,b.asDocument?1:0,b.roleId==='__all__'?1:0,b.roleId??null);
      for(const recipient of v.ids)db.prepare('INSERT INTO deliveries(message,recipient,updated) VALUES(?,?,?)').run(id,recipient,now);
      roleSupport.insertJob(id,role);
      if(onInsert)onInsert(id);
      enqueueAudit(id,b.room||'general',role,text,b.replyTo,b.fileId);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return {message:decorate(db.prepare(select+' WHERE m.id=?').get(id)),duplicate:false};
  }
  async function route(req,res,url,member,{send,json}) {
    const p=url.pathname;
    if(p==='/api/inbox/summary'&&req.method==='GET') {
      const s=db.prepare("SELECT count(*) count,coalesce(max(message),0) latestId,sum(CASE WHEN status IN ('pending','delivered') THEN 1 ELSE 0 END) unread FROM deliveries WHERE recipient=? AND status NOT IN ('processed','dismissed')").get(member.id);
      send(res,200,{...s,unread:s.unread||0});return true;
    }
    if(p==='/api/inbox'&&req.method==='GET') {
      const state=url.searchParams.get('state')||'open';
      const clauses={open:"AND d.status NOT IN ('processed','dismissed')",pending:"AND d.status IN ('pending','delivered')",all:''};
      if(!(state in clauses))throw Error('inbox state 无效');
      const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw Error('after 参数无效');
      const rows=db.prepare(select+` JOIN deliveries d ON d.message=m.id WHERE d.recipient=? AND m.id>? ${clauses[state]} ORDER BY m.id LIMIT 200`).all(member.id,after);
      send(res,200,rows.map(m=>{const r=decorate(m);r.deliveryStatus=r.recipients.find(x=>x.recipient===member.id).status;return r;}));return true;
    }
    if(p==='/api/receipts'&&req.method==='POST') {
      const b=await json(req);if(!Array.isArray(b.messageIds)||!b.messageIds.length||b.messageIds.length>200||b.messageIds.some(x=>!Number.isSafeInteger(x))||!['delivered','read','processed','dismissed'].includes(b.status))throw Error('回执参数无效');
      const ids=[...new Set(b.messageIds)];const rows=ids.map(id=>db.prepare('SELECT * FROM deliveries WHERE message=? AND recipient=?').get(id,member.id));
      if(rows.some(r=>!r))return send(res,403,{error:'只能确认发给自己的消息'}),true;
      db.exec('BEGIN IMMEDIATE');try{for(const r of rows){if(ranks[b.status]>ranks[r.status])db.prepare('UPDATE deliveries SET status=?,updated=? WHERE message=? AND recipient=?').run(b.status,new Date().toISOString(),r.message,member.id);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      const values=ids.map(id=>({messageId:id,receipts:receipts.all(id)}));for(const v of values)event({type:'receipt',...v});send(res,200,{ok:true,receipts:values});return true;
    }
    if(p==='/api/presence'&&req.method==='POST') {
      const b=await json(req);if(!['idle','busy','offline'].includes(b.state))throw Error('状态无效');
      db.prepare('INSERT INTO presence VALUES(?,?,?,?) ON CONFLICT(member) DO UPDATE SET state=excluded.state,session=excluded.session,updated=excluded.updated').run(member.id,b.state,String(b.sessionId||'').slice(0,150),new Date().toISOString());send(res,200,{ok:true});return true;
    }
    if(p==='/api/presence'&&req.method==='GET') {send(res,200,db.prepare('SELECT member,state,updated FROM presence').all().map(r=>({...r,state:Date.now()-Date.parse(r.updated)>90000?'offline':r.state})));return true;}
    return false;
  }
  return {decorate,create,route};
}
