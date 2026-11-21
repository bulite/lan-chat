import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const assetMaxBytes = 2 * 1024 * 1024;
const kinds = new Set(['sticker', 'avatar']);
const types = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
function imageType(bytes) {
  if(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&bytes.subarray(12,16).toString()==='IHDR')return 'image/png';
  if(bytes.subarray(0,3).toString('hex')==='ffd8ff'&&bytes.subarray(-2).toString('hex')==='ffd9')return 'image/jpeg';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())&&bytes.at(-1)===0x3b)return 'image/gif';
}

export function assets(db, dir) {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_assets (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    digest TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(kind,digest)
  );`);
  const assetFor = db.prepare('SELECT * FROM shared_assets WHERE id=?');
  const assetView = row => ({id:row.id,kind:row.kind,name:row.name,url:'/api/assets/'+row.id+'/content'});

  function list(kind) {
    if(kind!=null&&!kinds.has(kind))throw Error('素材类型无效');
    return db.prepare('SELECT * FROM shared_assets WHERE (? IS NULL OR kind=?) ORDER BY created DESC,id')
      .all(kind??null,kind??null).map(assetView);
  }
  function publish(kind, name, bytes, member) {
    if(!kinds.has(kind))throw Error('素材类型无效');
    if(typeof name!=='string'||!name.trim()||name.length>100)throw Error('请填写 100 字以内的素材名称');
    if(!bytes.length||bytes.length>assetMaxBytes)throw Error('图片大小须在 2 MiB 以内');
    const type=imageType(bytes);
    if(!type)throw Error('仅支持 PNG、JPEG、GIF 或 WebP 图片');
    const digest=createHash('sha256').update(bytes).digest('hex');
    const prior=db.prepare('SELECT * FROM shared_assets WHERE kind=? AND digest=?').get(kind,digest);
    if(prior)return assetView(prior);
    const id=randomUUID();
    const filename=name.trim().replace(/[\u0000-\u001f/\\]/g,'_').replace(/\.(?:png|jpe?g|gif|webp)$/i,'')+'.'+types[type];
    const filenameOnDisk=path.join(dir,'files',id);
    fs.writeFileSync(filenameOnDisk,bytes,{flag:'wx'});
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare('INSERT INTO files VALUES(?,?,?,?)').run(id,filename,bytes.length,member.id);
      db.prepare('INSERT INTO shared_assets VALUES(?,?,?,?,?,?)').run(id,kind,name.trim(),type,digest,new Date().toISOString());
      db.exec('COMMIT');
    }catch(error){
      db.exec('ROLLBACK');
      fs.unlinkSync(filenameOnDisk);
      throw error;
    }
    return assetView(assetFor.get(id));
  }
  function requireKind(id,kind) {
    if(typeof id!=='string'||assetFor.get(id)?.kind!==kind)throw Error('找不到所选共享素材');
    return id;
  }
  function decorate(message) {
    if(message?.fileId){
      const row=assetFor.get(message.fileId);
      if(row){
        const {id,kind,name,url}=assetView(row);
        Object.assign(message,{assetId:id,assetKind:kind,assetName:name,assetUrl:url});
      }
    }
    return message;
  }
  async function route(req,res,url,member,{send,body}) {
    if(url.pathname==='/api/assets'){
      const kind=url.searchParams.get('kind');
      if(req.method==='GET'){send(res,200,list(kind));return true;}
      if(req.method==='POST'){
        send(res,201,publish(kind,url.searchParams.get('name'),await body(req,assetMaxBytes),member));
        return true;
      }
    }
    const content=url.pathname.match(/^\/api\/assets\/([a-f0-9-]+)\/content$/);
    if(content&&req.method==='GET'){
      const row=assetFor.get(content[1]);
      if(!row){send(res,404,{error:'素材不存在'});return true;}
      const data=fs.readFileSync(path.join(dir,'files',row.id));
      res.writeHead(200,{'Content-Type':row.type,'Content-Length':data.length,'Cache-Control':'private, max-age=31536000, immutable',
        'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
      res.end(data);
      return true;
    }
    return false;
  }
  return {list,publish,requireKind,decorate,route};
}
