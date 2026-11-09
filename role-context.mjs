// Role-scoped chat operations. The plugin's authenticated identity must own
// a currently running job for the supplied session; all operations stay in
// that job's room and never alter the separately bound inbox session.
import fs from 'node:fs';import path from 'node:path';
export function roleContext(db,event,comm,roleSupport,select,dataDir){
  const summarize=m=>({id:m.id,sender:m.roleReply?.roleName||m.roleSender?.roleName||m.sender,roleId:m.roleReply?.roleId||m.roleSender?.roleId||null,kind:m.kind,replyTo:m.replyTo,created:m.created,text:m.asDocument||m.text.length>300?`[文档 ${m.text.length} 字；使用消息读取工具查看 #${m.id}]`:m.text,...(m.fileId?{attachment:{id:m.fileId,name:m.fileName,description:/\.(png|jpe?g|gif|webp|bmp)$/i.test(m.fileName)?'图片':'附件'}}:{})});
  function scope(sessionId,member){
    if(member.kind!=='agent'||typeof sessionId!=='string')throw Error('角色会话无效');
    const row=db.prepare("SELECT * FROM role_jobs root WHERE root.owner=? AND root.session_id=? AND root.steer_parent IS NULL AND (root.status IN ('starting','running') OR EXISTS (SELECT 1 FROM role_jobs child WHERE child.steer_parent=root.message AND child.status IN ('starting','running'))) ORDER BY root.message DESC LIMIT 1").get(member.id,sessionId);
    if(!row)throw Error('当前会话不是正在处理邻聊消息的角色会话');
    const source=roleSupport.getJob(row.message).sourceMessage,message=comm.decorate(db.prepare(select+' WHERE m.id=?').get(source));
    return {job:row,source,message,room:message.room};
  }
  async function route(req,res,url,member,{send,json}){
    if(url.pathname!=='/api/role-session' || req.method!=='POST')return false;
    const b=await json(req,1024*1024);let s=scope(b.sessionId,member);
    const replySource=b.action==='send'?b.replyTo:['skip','sent'].includes(b.action)?b.messageId:null;
    if(replySource!=null){
      if(!Number.isSafeInteger(replySource))throw Error('消息标识无效');
      const child=db.prepare("SELECT * FROM role_jobs WHERE owner=? AND session_id=? AND steer_parent=? AND status IN ('starting','running') AND COALESCE((SELECT original_message FROM role_job_origins WHERE job_id=role_jobs.message),message)=? LIMIT 1").get(member.id,b.sessionId,s.job.message,replySource);
      if(child){const message=comm.decorate(db.prepare(select+' WHERE m.id=?').get(replySource));s={...s,job:child,source:replySource,message};}
      else if(['skip','sent'].includes(b.action)&&replySource!==s.source)throw Error('该消息不属于当前回合的角色任务');
    }
    if(b.action==='context'){
      const room=db.prepare('SELECT id,name FROM rooms WHERE id=?').get(s.room);
      const members=db.prepare('SELECT id,name,kind FROM members WHERE disabled=0 AND kind=\'human\'').all();
      const roles=db.prepare('SELECT r.id,r.name,r.provider FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.deleted=0 ORDER BY r.name,r.id').all(s.room);
      const history=db.prepare('SELECT id FROM messages WHERE room=? AND id<=? ORDER BY id DESC LIMIT 6').all(s.room,s.source).reverse().map(x=>summarize(comm.decorate(db.prepare(select+' WHERE m.id=?').get(x.id))));
      send(res,200,{room,role:{id:s.job.role_id,name:s.job.role_name,provider:s.job.provider},members,roles,sourceMessage:s.source,recentMessages:history});return true;
    }
    if(b.action==='history'){
      const before=b.before??Number.MAX_SAFE_INTEGER,after=b.after??0,limit=b.limit??30;
      if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50)throw Error('消息分页参数无效');
      const rows=db.prepare('SELECT id FROM messages WHERE room=? AND id>? AND id<? ORDER BY id DESC LIMIT ?').all(s.room,after,before,limit+1);
      const hasMore=rows.length>limit,items=rows.slice(0,limit).reverse().map(x=>summarize(comm.decorate(db.prepare(select+' WHERE m.id=?').get(x.id))));
      send(res,200,{messages:items,hasMore,nextBefore:hasMore?items[0]?.id:null});return true;
    }
    if(b.action==='read'){
      if(!Number.isSafeInteger(b.messageId))throw Error('消息标识无效');
      const raw=db.prepare(select+' WHERE m.id=? AND m.room=?').get(b.messageId,s.room);if(!raw)throw Error('消息不在当前群聊');
      const m=comm.decorate(raw);send(res,200,{...summarize(m),text:m.text});return true;
    }
    if(b.action==='sent'){
      const rows=db.prepare('SELECT message FROM role_messages WHERE source_job=? ORDER BY message').all(s.job.message);
      const skipped=!!db.prepare('SELECT 1 FROM role_decisions WHERE source_job=?').get(s.job.message);
      send(res,200,{messageIds:rows.map(x=>x.message),skipped});return true;
    }
    if(b.action==='skip'){
      if(db.prepare('SELECT 1 FROM role_messages WHERE source_job=?').get(s.job.message))throw Error('已经发送过消息，不能标记无需回复');
      if(b.reason!=null&&(typeof b.reason!=='string'||b.reason.length>300))throw Error('原因无效');
      db.prepare('INSERT OR IGNORE INTO role_decisions(source_job,reason) VALUES(?,?)').run(s.job.message,b.reason||null);
      send(res,200,{skipped:true});return true;
    }
    if(b.action==='attachment'){
      if(typeof b.fileId!=='string'||!b.fileId)throw Error('附件标识无效');
      const file=db.prepare('SELECT f.id,f.name,f.size FROM files f JOIN messages m ON m.file=f.id WHERE f.id=? AND m.room=? LIMIT 1').get(b.fileId,s.room);
      if(!file||file.size>25*1024*1024)throw Error('附件不属于当前群或超过大小限制');
      const bytes=fs.readFileSync(path.join(dataDir,'files',file.id));if(bytes.length!==file.size)throw Error('附件大小不一致');
      send(res,200,{name:file.name,size:file.size,base64:bytes.toString('base64')});return true;
    }
    if(b.action==='send'){
      if(db.prepare('SELECT 1 FROM role_decisions WHERE source_job=?').get(s.job.message))throw Error('此任务已标记无需回复');
      if(typeof b.text!=='string'||!b.text.trim()||b.text.length>100000)throw Error('消息内容无效');
      if(typeof b.clientMessageId!=='string'||!b.clientMessageId||b.clientMessageId.length>80)throw Error('需要不超过 80 字符的稳定消息标识');
      let target=null;
      if(b.targetRoleId!=null){
        target=db.prepare('SELECT r.id,r.owner,r.provider,r.name,r.model,rr.effort FROM room_roles rr JOIN roles r ON r.id=rr.role_id WHERE rr.room=? AND r.id=? AND r.deleted=0').get(s.room,b.targetRoleId);if(!target||target.id===s.job.role_id)throw Error('目标必须是当前群内的其他角色');target.autoRouted=true;
      }
      let targetJob=null;
      const result=comm.create({room:s.room,text:b.text,replyTo:b.replyTo??s.source,asDocument:b.asDocument===true,clientMessageId:'role-'+s.job.message+'-'+b.clientMessageId},member,b.text.trim(),id=>{
        db.prepare('INSERT INTO role_messages(message,role_id,role_name,provider,source_job,target_role_id) VALUES(?,?,?,?,?,?)').run(id,s.job.role_id,s.job.role_name,s.job.provider,s.job.message,target?.id??null);
        if(target)targetJob=roleSupport.insertAdditionalJob(id,target);
      });
      if(result.duplicate&&db.prepare('SELECT target_role_id FROM role_messages WHERE message=?').get(result.message.id)?.target_role_id!==(target?.id??null))throw Error('消息标识已用于不同目标');
      if(!result.duplicate){event({type:'message',message:result.message});if(targetJob!==null)event({type:'role-job',job:roleSupport.getJob(targetJob)});}
      send(res,result.duplicate?200:201,{message:result.message});return true;
    }
    throw Error('不支持的角色群聊操作');
  }
  return {route};
}
