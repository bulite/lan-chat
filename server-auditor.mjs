import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {
  listAuditorModels, normalizeAuditorUrl, routeAuditor, summarizeAuditor, estimateAuditorInput,
  ROUTING_PROMPT, COMPACTION_PROMPT, ROUTING_RESERVE, COMPACTION_RESERVE
} from './server-auditor-model.mjs';

const PROVIDER = 'server';
const DEFAULT_LIMIT = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function clip(text, bytes) {
  const encoded = encoder.encode(text);
  return encoded.length <= bytes ? text : decoder.decode(encoded.subarray(0, bytes)).replace(/\uFFFD$/, '') + '…';
}

export function serverAuditor(db, adminToken, publishStatus, selectMessage) {
  db.exec(`CREATE TABLE IF NOT EXISTS room_auditors(
    room TEXT PRIMARY KEY, enabled INTEGER NOT NULL, url TEXT NOT NULL, model TEXT NOT NULL,
    secret TEXT NOT NULL, context_limit INTEGER NOT NULL, revision TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', summary_through INTEGER NOT NULL DEFAULT 0
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS auditor_profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,
    model TEXT NOT NULL,secret TEXT NOT NULL,context_limit INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS auditor_preferences(profile_id TEXT PRIMARY KEY, routing_bias TEXT NOT NULL);`);
  const biasFor=db.prepare('SELECT routing_bias FROM auditor_preferences WHERE profile_id=?');
  if(!db.prepare('PRAGMA table_info(room_auditors)').all().some(row=>row.name==='profile_id'))
    db.exec('ALTER TABLE room_auditors ADD COLUMN profile_id TEXT');
  if(!db.prepare('PRAGMA table_info(audit_jobs)').all().some(row=>row.name==='trace'))
    db.exec('ALTER TABLE audit_jobs ADD COLUMN trace TEXT');
  const configFor = db.prepare('SELECT * FROM room_auditors WHERE room=?');
  const key = createHash('sha256').update('lan-chat room auditor\0').update(adminToken || '').digest();
  function encrypt(secret, room) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(room));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  function decrypt(secret, room) {
    const data = Buffer.from(secret, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(room));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
  const profileFor=db.prepare('SELECT * FROM auditor_profiles WHERE id=?');
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const row of db.prepare(`SELECT a.*,r.name FROM room_auditors a JOIN rooms r ON r.id=a.room
      WHERE a.profile_id IS NULL AND a.url<>'' AND a.model<>'' AND a.secret<>''`).all()){
      const secret=decrypt(row.secret,row.room);
      const existing=db.prepare('SELECT * FROM auditor_profiles WHERE url=? AND model=? AND context_limit=?')
        .all(row.url,row.model,row.context_limit).find(profile=>decrypt(profile.secret,profile.id)===secret);
      const id=existing?.id??randomUUID();
      if(!existing)db.prepare('INSERT INTO auditor_profiles VALUES(?,?,?,?,?,?)')
        .run(id,row.name+' · '+row.model,row.url,row.model,encrypt(secret,id),row.context_limit);
      db.prepare('UPDATE room_auditors SET profile_id=? WHERE room=?').run(id,row.room);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}

  function profiles(){
    return db.prepare(`SELECT p.id,p.name,p.url,p.model,p.context_limit AS contextLimit,COALESCE(a.routing_bias,'balanced') AS routingBias
      FROM auditor_profiles p LEFT JOIN auditor_preferences a ON a.profile_id=p.id ORDER BY p.name,p.id`)
      .all().map(profile=>({...profile,hasApiKey:true}));
  }
  function saveProfile(input){
    const previous=input.id?profileFor.get(input.id):null;
    if(input.id&&!previous)throw Error('审查员不存在');
    const id=previous?.id??randomUUID(),name=input.name?.trim(),model=input.model?.trim();
    const url=normalizeAuditorUrl(input.url);
    const previousBias=biasFor.get(id)?.routing_bias??'balanced';
    const routingBias=input.routingBias===undefined?previousBias:input.routingBias;
    if(!['forward','balanced','hold'].includes(routingBias))throw Error('转发倾向无效');
    if(!name||name.length>80||!model||model.length>200||!Number.isInteger(input.contextLimit)||
      input.contextLimit<2048||input.contextLimit>131072)throw Error('请填写有效的名称、模型和上下文上限');
    const supplied=input.apiKey?.trim();
    if(supplied&&(supplied.length>4096||/[^ -~]/.test(supplied)))throw Error('API 密钥无效');
    const key=supplied||(previous?.url===url?decrypt(previous.secret,id):'');
    if(!key)throw Error('请填写 API 密钥');
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare(`INSERT INTO auditor_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,url=excluded.url,model=excluded.model,secret=excluded.secret,context_limit=excluded.context_limit`)
        .run(id,name,url,model,encrypt(key,id),input.contextLimit);
      db.prepare(`INSERT INTO auditor_preferences VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET routing_bias=excluded.routing_bias`)
        .run(id,routingBias);
      for(const room of db.prepare('SELECT * FROM room_auditors WHERE profile_id=?').all(id)){
        const sameConnection=room.url===url&&room.model===model&&room.context_limit===input.contextLimit&&decrypt(room.secret,room.room)===key;
        if(sameConnection&&routingBias===previousBias)continue;
        if(sameConnection)db.prepare('UPDATE room_auditors SET revision=? WHERE room=?').run(randomUUID(),room.room);
        else db.prepare(`UPDATE room_auditors SET url=?,model=?,secret=?,context_limit=?,revision=?,summary='',summary_through=?
          WHERE room=?`).run(url,model,encrypt(key,room.room),input.contextLimit,randomUUID(),
          db.prepare('SELECT id FROM messages WHERE room=? ORDER BY id DESC LIMIT 1 OFFSET 12').get(room.room)?.id??0,room.room);
        db.prepare(`UPDATE audit_jobs SET status='pending',token=NULL,claimed_at=NULL,model=?,trace=NULL WHERE provider=?
          AND status IN ('claimed','pending') AND message IN (SELECT id FROM messages WHERE room=?)`).run(model,PROVIDER,room.room);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return profiles().find(profile=>profile.id===id);
  }
  function selectProfile(room,id){
    const profile=id?profileFor.get(id):null;
    if(id&&!profile)throw Error('审查员不存在');
    const previous=configFor.get(room);
    if((previous?.enabled&&previous.profile_id===id)||(!id&&!previous?.enabled))return publicConfig(room);
    save(room,profile?{enabled:true,url:profile.url,model:profile.model,contextLimit:profile.context_limit,apiKey:decrypt(profile.secret,id)}
      :{enabled:false,url:'',model:'',contextLimit:DEFAULT_LIMIT});
    db.prepare('UPDATE room_auditors SET profile_id=? WHERE room=?').run(id||null,room);
    return publicConfig(room);
  }
  function history(roomId){
    return db.prepare(`SELECT a.message,a.provider,a.model,a.status,a.error,a.reason,a.trace,m.created,r.name AS room,
      substr(m.text,1,160) AS excerpt FROM audit_jobs a JOIN messages m ON m.id=a.message
      JOIN rooms r ON r.id=m.room WHERE (? IS NULL OR m.room=?)
      ORDER BY a.message DESC,a.provider LIMIT 100`).all(roomId,roomId)
      .map(row=>({...row,trace:row.trace?JSON.parse(row.trace):null}));
  }

  function publicConfig(room) {
    const config = configFor.get(room);
    return {
      enabled: Boolean(config?.enabled),
      profileId: config?.enabled ? config.profile_id : null,
      url: config?.url ?? '',
      model: config?.model ?? '',
      contextLimit: config?.context_limit ?? DEFAULT_LIMIT,
      hasApiKey: Boolean(config?.secret)
    };
  }

  function save(room, input) {
    const previous = configFor.get(room);
    if (typeof input?.enabled !== 'boolean' || !Number.isInteger(input.contextLimit) ||
        input.contextLimit < 2048 || input.contextLimit > 131072) throw Error('上下文上限须为 2048 至 131072 的整数');
    if (typeof input.url !== 'string' || typeof input.model !== 'string' ||
        input.url.length > 2048 || input.model.length > 200) throw Error('模型地址或名称无效');
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' ||
        input.apiKey.length > 4096 || /[\u0000-\u001f\u007f-\uffff]/u.test(input.apiKey))) throw Error('模型 API 密钥无效');
    const url = input.url.trim() ? normalizeAuditorUrl(input.url.trim()) : '';
    const model = input.model.trim();
    const newKey = input.apiKey?.trim();
    if (newKey && !url) throw Error('请先填写模型地址');
    if (url && previous?.secret && url !== previous.url && !newKey) throw Error('更换模型地址时请重新填写 API 密钥');
    const secret = newKey ? encrypt(newKey, room) : url === previous?.url ? previous.secret : '';
    if (input.enabled && (!url || !model || !secret)) throw Error('启用审查员需要模型地址、名称和 API 密钥');
    const sameContext = url === previous?.url && model === previous?.model && previous.enabled && input.enabled;
    const revision = randomUUID();

    const waiting = db.prepare(`SELECT DISTINCT a.message FROM audit_jobs a JOIN messages m ON m.id=a.message
      WHERE m.room=? AND a.status IN ('pending','claimed')`).all(room);
    const requested = db.prepare(`SELECT DISTINCT a.message FROM audit_jobs a JOIN messages m ON m.id=a.message
      WHERE m.room=? AND a.status IN ('pending','claimed') AND NOT EXISTS (
        SELECT 1 FROM role_jobs j WHERE j.message=a.message OR j.message IN
        (SELECT job_id FROM role_job_origins WHERE original_message=a.message)) ORDER BY a.message`).all(room);
    const recentBefore = db.prepare('SELECT id FROM messages WHERE room=? AND id<? ORDER BY id DESC LIMIT 1 OFFSET 12')
      .get(room, requested[0]?.message ?? Number.MAX_SAFE_INTEGER)?.id ?? 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO room_auditors(room,enabled,url,model,secret,context_limit,revision,summary,summary_through)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(room) DO UPDATE SET enabled=excluded.enabled,url=excluded.url,
        model=excluded.model,secret=excluded.secret,context_limit=excluded.context_limit,
        revision=excluded.revision,summary=excluded.summary,summary_through=excluded.summary_through`)
        .run(room, Number(input.enabled), url, model, secret, input.contextLimit, revision,
          sameContext ? previous.summary : '', sameContext ? previous.summary_through : recentBefore);
      if (input.enabled || previous?.enabled) {
        db.prepare(`UPDATE audit_jobs SET status='ignored',token=NULL,claimed_at=NULL WHERE status IN ('pending','claimed')
          AND message IN (SELECT id FROM messages WHERE room=?) AND (provider=? OR ?=1)`)
          .run(room, PROVIDER, Number(input.enabled));
      }
      if (input.enabled) {
        const upsert = db.prepare(`INSERT INTO audit_jobs(message,owner,provider,model,status) VALUES(?,'',?,?,'pending')
          ON CONFLICT(message,owner,provider) DO UPDATE SET model=excluded.model,status='pending',token=NULL,claimed_at=NULL,error=NULL,reason=NULL`);
        for (const row of requested) upsert.run(row.message, PROVIDER, model);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (input.enabled || previous?.enabled) for (const row of waiting) publishStatus(row.message, room);
    return publicConfig(room);
  }

  function enqueue(messageId, room) {
    const config = configFor.get(room);
    if (!config?.enabled) return false;
    db.prepare('INSERT OR IGNORE INTO audit_jobs(message,owner,provider,model) VALUES(?,?,?,?)')
      .run(messageId, '', PROVIDER, config.model);
    return true;
  }

  const roleReplySource=db.prepare('SELECT original_message FROM role_job_origins WHERE job_id=?');
  function rowSummary(id) {
    const m = selectMessage(id);
    if (!m) return null;
    const jobId=m.roleSender?.sourceJob;
    const source=m.roleReply?.message??(jobId==null?null:roleReplySource.get(jobId)?.original_message??jobId);
    return {
      id, sender: m.roleReply?.roleName || m.roleSender?.roleName || m.sender,
      kind: m.kind, ...(m.roleReply||m.roleSender?{senderRoleId:(m.roleReply||m.roleSender).roleId}:{}), replyTo: m.replyTo ?? source,
      text: m.asDocument ? '[文档]' : clip(m.text, 360),
      ...(m.fileId ? {attachment: clip(m.fileName, 100)} : {})
    };
  }

  const previousIds = db.prepare('SELECT id FROM messages WHERE room=? AND id>? AND id<? ORDER BY id LIMIT 32');
  const persistSummary = db.prepare('UPDATE room_auditors SET summary=?,summary_through=? WHERE room=? AND revision=?');
  async function context(room, message, candidates, config, onCompaction) {
    const saved = configFor.get(room.id);
    const ensureCurrent = () => {
      if (configFor.get(room.id)?.revision !== config.revision) throw Error('审查设置已更新');
    };
    const current = rowSummary(message.id);
    const payload = {room: room.name, candidates: candidates.map(({id,name,provider}) => ({id,name,provider})),
      routingBias: config.routingBias, summary: '', history: [], message: current};
    const routeFits = () => estimateAuditorInput(ROUTING_PROMPT, payload) + ROUTING_RESERVE <= config.contextLimit;
    const compactFits = data => estimateAuditorInput(COMPACTION_PROMPT, data) + COMPACTION_RESERVE <= config.contextLimit;
    if (!routeFits()) throw Error('上下文上限不足以容纳当前消息和候选角色');

    // An older queued message must never receive a summary containing later messages.
    const canPersist = saved.summary_through < message.id;
    let cursor = canPersist ? saved.summary_through : 0;
    if (!canPersist) {
      cursor = db.prepare('SELECT id FROM messages WHERE room=? AND id<? ORDER BY id DESC LIMIT 1 OFFSET 12')
        .get(room.id, message.id)?.id ?? 0;
    }
    const summaryLimit = Math.min(1000, Math.floor(config.contextLimit / 8));
    payload.summary = canPersist ? clip(saved.summary, summaryLimit) : '';
    if (!routeFits()) payload.summary = '';
    for (;;) {
      const rows = previousIds.all(room.id, cursor, message.id);
      if (!rows.length) break;
      for (const {id} of rows) {
        cursor = id;
        const entry = rowSummary(id);
        if (!entry) continue;
        payload.history.push(entry);
        while (!routeFits() || !compactFits({summary: payload.summary, history: payload.history})) {
          // Keep the newest message verbatim when possible. The current routing target is separate.
          const count = Math.max(1, Math.ceil(payload.history.length / 2));
          const older = payload.history.slice(0, count);
          const data = {summary: payload.summary, history: older};
          while (!compactFits(data) && older.length > 1) older.pop();
          if (!compactFits(data)) data.summary = '';
          if (!compactFits(data)) throw Error('上下文上限不足以压缩历史');
          ensureCurrent();
          onCompaction();
          payload.summary = clip(await summarizeAuditor(config, data), summaryLimit);
          ensureCurrent();
          payload.history.splice(0, older.length);
          if (!routeFits() && !payload.history.length) payload.summary = '';
          if (canPersist) persistSummary.run(payload.summary, older.at(-1).id, room.id, config.revision);
        }
      }
    }
    ensureCurrent();
    return payload;
  }

  const next = db.prepare(`SELECT a.*,m.room FROM audit_jobs a JOIN messages m ON m.id=a.message
    JOIN room_auditors c ON c.room=m.room AND c.enabled=1
    WHERE a.provider=? AND (a.status='pending' OR a.status='claimed' AND a.claimed_at<?)
    ORDER BY a.message LIMIT 1`);
  let running = false;
  async function pump(candidateRoles, complete) {
    if (running) return;
    const row = next.get(PROVIDER, Date.now() - 300000);
    if (!row) return;
    running = true;
    const token = randomUUID();
    try {
      db.prepare("UPDATE audit_jobs SET status='claimed',token=?,claimed_at=? WHERE message=? AND owner='' AND provider=?")
        .run(token, Date.now(), row.message, PROVIDER);
      const message = selectMessage(row.message);
      const stored = configFor.get(row.room);
      let verdict = {roleIds: []};
      const trace={startedAt:new Date().toISOString(),stage:'筛选候选角色',candidates:[],selected:[]};
      const writeTrace=()=>db.prepare('UPDATE audit_jobs SET trace=? WHERE message=? AND provider=? AND token=?')
        .run(JSON.stringify(trace),row.message,PROVIDER,token);
      try {
        const candidates = candidateRoles(message, row);
        trace.candidates=candidates.map(({id,name,provider})=>({id,name,provider}));
        trace.stage=candidates.length?'准备群聊上下文':'无可用候选';
        writeTrace();
        if(candidates.length){
          const room = db.prepare('SELECT id,name FROM rooms WHERE id=?').get(row.room);
          const config = {url: stored.url, model: stored.model, revision: stored.revision,
            contextLimit: stored.context_limit, routingBias: biasFor.get(stored.profile_id)?.routing_bias??'balanced', apiKey: decrypt(stored.secret, room.id)};
          const payload = await context(room, message, candidates, config,()=>{
            trace.stage='正在压缩历史';
            trace.compactions=(trace.compactions||0)+1;
            writeTrace();
          });
          trace.stage='等待模型判断';
          trace.historyCount=payload.history.length;
          trace.hasSummary=Boolean(payload.summary);
          writeTrace();
          verdict = await routeAuditor(config, payload);
          trace.selected=verdict.roleIds;
        }
      } catch (error) {
        verdict = {error: error.message};
      }
      const current = db.prepare('SELECT token,status FROM audit_jobs WHERE message=? AND owner=? AND provider=?')
        .get(row.message, row.owner, row.provider);
      if (current?.token === token && current.status === 'claimed') {
        trace.stage=verdict.error?'失败':'判断完成';
        trace.finishedAt=new Date().toISOString();
        writeTrace();
        complete(row, message, verdict);
      }
    } finally {
      running = false;
    }
  }
  function profileModels(input){
    const profile=input.id?profileFor.get(input.id):null;
    const url=normalizeAuditorUrl(input.url);
    const key=input.apiKey?.trim()||(profile?.url===url?decrypt(profile.secret,profile.id):'');
    if(key.length>4096||/[^ -~]/.test(key))throw Error('API 密钥无效');
    return listAuditorModels(url,key);
  }
  return {publicConfig, selectProfile, profiles, saveProfile, profileModels, history, enqueue, pump};
}
