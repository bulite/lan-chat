import {createRoleUI,renderRoleJob} from './roles-ui.js';
const $=id=>document.getElementById(id);let me,room=null,rooms=[],messages=[],pending=null,controller,seen=new Set(),memberList=[];
const themeButton = $('themeToggle');
const themePreference = matchMedia('(prefers-color-scheme: dark)');
let selectedTheme;
try { selectedTheme = localStorage.getItem('lan-chat:theme'); } catch {}

function applyTheme() {
  const night = selectedTheme ? selectedTheme === 'dark' : themePreference.matches;
  document.documentElement.dataset.theme = night ? 'dark' : 'light';
  const label = night ? '切换日间模式' : '切换夜间模式';
  themeButton.textContent = night ? '☀ 日间' : '☾ 夜间';
  themeButton.setAttribute('aria-label', label);
}
themeButton.onclick = () => {
  selectedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('lan-chat:theme', selectedTheme); } catch {}
  applyTheme();
};
themePreference.addEventListener('change', applyTheme);
applyTheme();

async function api(p,options={}){const r=await fetch(p,{...options,headers:{...options.headers}});if(!r.ok){let e;try{e=(await r.json()).error}catch{e='请求失败'}throw Error(e);}return r;}
const get=async p=>(await api(p)).json();const post=async(p,b)=>(await api(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
const roleUI=createRoleUI({get,draft:$('draft'),getRoom:()=>room});
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
const avatarOptions = ['🐱', '🦊', '🐼', '🐸', '🦉', '🤖', '👾', '🚀', '🐶', '🐰', '🐻', '🐯', '🐧', '🐙', '🐢', '🦄', '🌙', '⚡'];
const avatarStorageKey = 'lan-chat:member-avatars';
let memberAvatars = {};
try {
  memberAvatars = JSON.parse(localStorage.getItem(avatarStorageKey) || '{}') || {};
} catch {}

function paintAvatar(node, id, name) {
  const choice = memberAvatars[id];
  node.replaceChildren();
  if (typeof choice === 'string' && /^data:image\/webp;base64,/.test(choice)) {
    const image = el('img');
    const bytes = Uint8Array.from(atob(choice.slice('data:image/webp;base64,'.length)), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], {type:'image/webp'}));
    image.onload = image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;
    image.alt = '';
    node.append(image);
  } else {
    node.textContent = avatarOptions.includes(choice) ? choice : name.slice(0,1);
  }
}

function memberAvatar(id, name, agent) {
  const node = el('span', 'avatar' + (agent ? ' agent' : ''));
  node.dataset.avatarId = id;
  node.dataset.avatarName = name;
  paintAvatar(node, id, name);
  return node;
}

function editAvatar(id, name) {
  const dialog = el('dialog', 'avatar-dialog');
  dialog.setAttribute('aria-label', '设置头像');
  const heading = el('h3', '', name + ' · 设置头像');
  const note = el('p', '', '头像设置保存在当前浏览器。');
  const grid = el('div', 'avatar-options');
  const status = el('p');
  status.setAttribute('role', 'status');

  function save(choice) {
    try {
      const next = {...memberAvatars};
      if (choice) next[id] = choice;
      else delete next[id];
      localStorage.setItem(avatarStorageKey, JSON.stringify(next));
      memberAvatars = next;
      for (const node of document.querySelectorAll('[data-avatar-id]')) {
        if (node.dataset.avatarId === id) paintAvatar(node, id, node.dataset.avatarName);
      }
      dialog.close();
    } catch {
      status.textContent = '保存失败，请检查浏览器的存储设置。';
    }
  }

  for (const icon of avatarOptions) {
    const button = el('button', 'avatar-option', icon);
    button.type = 'button';
    button.setAttribute('aria-label', '使用 ' + icon + ' 头像');
    button.onclick = () => save(icon);
    grid.append(button);
  }
  const file = el('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/webp,image/gif';
  file.hidden = true;
  file.onchange = async () => {
    const image = file.files[0];
    if (!image) return;
    if (image.size > 10 * 1024 * 1024) {
      status.textContent = '请选择 10 MB 以内的图片。';
      return;
    }
    try {
      const bitmap = await createImageBitmap(image);
      try {
        const canvas = el('canvas');
        canvas.width = canvas.height = 128;
        const size = Math.min(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, (bitmap.width-size)/2, (bitmap.height-size)/2, size, size, 0, 0, 128, 128);
        const url = canvas.toDataURL('image/webp', .85);
        if (!url.startsWith('data:image/webp;')) throw Error('WebP unavailable');
        if (dialog.open) save(url);
      } finally {
        bitmap.close();
      }
    } catch {
      status.textContent = '无法读取这张图片，请换一张试试。';
    }
  };
  const actions = el('div', 'avatar-actions');
  const upload = el('button', '', '上传图片');
  upload.onclick = () => file.click();
  const reset = el('button', '', '恢复默认');
  reset.onclick = () => save(null);
  const close = el('button', '', '取消');
  close.onclick = () => dialog.close();
  actions.append(upload, reset, close);
  dialog.append(heading, note, grid, file, status, actions);
  dialog.addEventListener('close', () => dialog.remove(), {once:true});
  document.body.append(dialog);
  dialog.showModal();
}

function avatarEditButton(id, name) {
  const button = el('button', 'avatar-edit', '头像');
  button.type = 'button';
  button.setAttribute('aria-label', '设置 ' + name + ' 的头像');
  button.onclick = () => editAvatar(id, name);
  return button;
}

const previewDialog=el('dialog','content-dialog');document.body.append(previewDialog);
const markdown = globalThis.markdownit({html: false, linkify: false});
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

function renderMarkdown(content) {
  const article = el('article', 'markdown-preview');
  article.innerHTML = markdown.render(content);
  return article;
}

function showContent(title, content, format = 'text', downloadUrl) {
  previewDialog.replaceChildren();
  previewDialog.setAttribute('aria-label', title);
  const header = el('div', 'content-dialog-header');
  header.append(el('strong', '', title));
  const actions = el('div', 'preview-actions');
  if (downloadUrl) {
    const download = el('a', '', '下载');
    download.href = downloadUrl;
    download.download = title;
    actions.append(download);
  }
  const close = el('button', '', '关闭');
  close.type = 'button';
  close.onclick = () => previewDialog.close();
  actions.append(close);
  header.append(actions);
  previewDialog.append(header);
  if (format === 'image') {
    const image = el('img');
    image.src = content;
    image.alt = title;
    previewDialog.append(image);
  } else if (format === 'markdown') {
    previewDialog.append(renderMarkdown(content));
  } else {
    previewDialog.append(el('pre', '', content));
  }
  if (!previewDialog.open) previewDialog.showModal();
  previewDialog.scrollTop = 0;
}

const imageAttachment = /\.(png|jpe?g|gif|webp|bmp)$/i;
const markdownAttachment = /\.(md|markdown)$/i;

async function openAttachment(message) {
  const {b: blob, u: url} = await fileBlob(message.fileId);
  if (markdownAttachment.test(message.fileName)) {
    showContent(message.fileName, await blob.text(), 'markdown', url);
  } else if (imageAttachment.test(message.fileName)) {
    showContent(message.fileName, url, 'image');
  } else {
    const download = el('a');
    download.href = url;
    download.download = message.fileName;
    download.click();
  }
}

const messageMenu = el('dialog', 'message-menu');
document.body.append(messageMenu);
messageMenu.addEventListener('click', event => {
  if (event.target === messageMenu) messageMenu.close();
});

function forwardMessage(message) {
  const dialog = el('dialog', 'forward-dialog');
  dialog.setAttribute('aria-label', '转发消息');
  const title = el('h3', '', '转发到群聊');
  const target = el('select');
  target.setAttribute('aria-label', '目标群聊');
  for (const entry of rooms) {
    const option = el('option', '', entry.name);
    option.value = entry.id;
    target.append(option);
  }
  target.value = room;
  const cancel = el('button', '', '取消');
  cancel.onclick = () => dialog.close();
  const confirm = el('button', '', '放入草稿');
  confirm.onclick = async () => {
    const destination = rooms.find(entry => entry.id === target.value);
    if (!destination) return;
    const draft = $('draft');
    if (draft.value.trim()) {
      error.textContent = '请先发送或清空当前草稿。';
      return;
    }
    dialog.close();
    if (destination.id !== room) await selectRoom(destination.id);
    draft.value = '转发自 ' + message.sender + '\n\n' + message.text;
    $('asDocument').checked = true;
    draft.dispatchEvent(new Event('input', {bubbles:true}));
    draft.focus();
  };
  const error = el('p');
  error.setAttribute('role', 'status');
  const actions = el('div', 'forward-actions');
  actions.append(cancel, confirm);
  dialog.append(title, target, error, actions);
  dialog.addEventListener('close', () => dialog.remove(), {once:true});
  document.body.append(dialog);
  dialog.showModal();
}

function showMessageMenu(message) {
  messageMenu.replaceChildren(el('strong', '', '消息操作'));
  const actions = [
    ['打开为 Markdown', () => showContent('消息全文', message.text, 'markdown')],
    ['打开为纯文本', () => showContent('消息全文', message.text)],
    ['另存为 Markdown', () => {
      const url = URL.createObjectURL(new Blob([message.text], {type:'text/markdown;charset=utf-8'}));
      const link = el('a');
      link.href = url;
      link.download = 'message-' + message.id + '.md';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }],
    ['转发…', () => forwardMessage(message)],
    ['取消', () => {}],
  ];
  for (const [label, run] of actions) {
    const button = el('button', '', label);
    button.onclick = () => { messageMenu.close(); run(); };
    messageMenu.append(button);
  }
  if (!messageMenu.open) messageMenu.showModal();
}

function addMessageActions(button, message) {
  let timer, origin, longPressed = false;
  button.oncontextmenu = event => {
    event.preventDefault();
    clearTimeout(timer);
    showMessageMenu(message);
  };
  button.onpointerdown = event => {
    longPressed = false;
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    origin = [event.clientX, event.clientY];
    timer = setTimeout(() => {
      longPressed = true;
      showMessageMenu(message);
    }, 550);
  };
  button.onpointermove = event => {
    if (origin && Math.hypot(event.clientX-origin[0], event.clientY-origin[1]) > 10) clearTimeout(timer);
  };
  button.onpointerup = button.onpointercancel = () => clearTimeout(timer);
  button.onkeydown = event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      showMessageMenu(message);
    }
  };
  button.onclick = () => {
    if (longPressed) { longPressed = false; return; }
    showContent('消息全文', message.text, 'markdown');
  };
}

let replyContext=null;
const replyBanner=el('div','reply-context');replyBanner.hidden=true;$('filePreview').insertAdjacentElement('afterend',replyBanner);
function clearReply(){replyContext=null;replyBanner.hidden=true;replyBanner.replaceChildren();}
function chooseReply(messageId,roleId){try{const role=roleUI.prepareReply(roleId);replyContext={messageId,roleId,room};replyBanner.replaceChildren(el('span','','引用 '+role.name+' · 消息 #'+messageId));const cancel=el('button','','取消');cancel.type='button';cancel.onclick=clearReply;replyBanner.append(cancel);replyBanner.hidden=false;}catch(e){$('notice').textContent=e.message;}}
function addReplyAction(row,messageId,roleId){if(me.kind!=='human'||row.querySelector('.role-reply-action'))return;const b=el('button','role-reply-action','引用');b.type='button';b.onclick=()=>chooseReply(messageId,roleId);row.querySelector('.message-content').append(b);}
function renderRooms(){const list=$('rooms');list.replaceChildren();for(const r of rooms.filter(r=>r.name.includes($('search').value))){const b=el('button','room'+(r.id===room?' active':''));b.append(el('span','avatar','群'));const details=el('div');details.append(el('strong','',r.name),el('small','','共享群聊'));b.append(details);b.onclick=()=>{ $('workspace').classList.add('chat-open'); selectRoom(r.id); };list.append(b);}}
const blobs=new Set();function clearBlobs(){for(const b of blobs)URL.revokeObjectURL(b);blobs.clear();}
async function fileBlob(id){const b=await(await api('/api/files/'+id)).blob();const u=URL.createObjectURL(b);blobs.add(u);return{b,u};}
function appendMessage(m){if(seen.has(m.id))return;seen.add(m.id);$('messages').querySelector('.empty')?.remove();const row=el('article','message'+(m.senderId===me.id?' self':''));const speaker=m.roleReply||m.roleSender;const avatar=memberAvatar(speaker?'role:'+speaker.roleId:m.senderId,speaker?.roleName||m.sender,m.kind==='agent'||Boolean(speaker));const c=el('div','message-content'),meta=el('div','meta');meta.append(el('span','',speaker?.roleName||m.sender));if(speaker)meta.append(el('span','badge',(speaker.provider==='codex'?'Codex':'DSH')+' · '+speaker.roleId.slice(-6)));if(m.kind==='agent')meta.append(el('span','badge','AGENT'));meta.append(el('time','',new Date(m.created).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));const bubble=el('div','bubble');if(m.recipients?.length)bubble.append(el('div','directed','通知 '+m.recipients.map(r=>r.name).join('、')));if(m.roleReply)bubble.append(el('div','directed','回复消息 #'+m.roleReply.message));if(m.text){const isAgent=m.kind==='agent'||Boolean(speaker);if(m.asDocument||m.text.length>300){const card=el('button','text-card');card.type='button';card.append(el('span','text-card-icon','📄'),el('span','',`文档 · ${m.text.length} 字\n点击查看全文`));if(isAgent)addMessageActions(card,m);else card.onclick=()=>showContent('消息全文',m.text);bubble.append(card);}else if(isAgent){const message=el('button','agent-message-text',m.text);message.type='button';message.title='点击打开 Markdown，右键或长按查看更多操作';addMessageActions(message,m);bubble.append(message);}else bubble.append(el('div','',m.text));}if(m.fileId){const b=el('button','attachment');b.type='button';const isMarkdown=markdownAttachment.test(m.fileName);b.append(el('span','attachment-name',m.fileName),el('small','',`${(m.fileSize/1024).toFixed(1)} KB · ${isMarkdown?'预览 Markdown':imageAttachment.test(m.fileName)?'查看图片':'下载文件'}`));b.onclick=async()=>{b.disabled=true;try{await openAttachment(m);}catch(e){$('notice').textContent=e.message;}finally{b.disabled=false;}};bubble.append(b);if(/\.(png|jpe?g|gif|webp|bmp)$/i.test(m.fileName))fileBlob(m.fileId).then(({b:blob,u})=>{if(!row.isConnected){URL.revokeObjectURL(u);return}const img=el('img');img.src=URL.createObjectURL(new Blob([blob],{type:/\.png$/i.test(m.fileName)?'image/png':/\.gif$/i.test(m.fileName)?'image/gif':/\.webp$/i.test(m.fileName)?'image/webp':/\.bmp$/i.test(m.fileName)?'image/bmp':'image/jpeg'}));blobs.add(img.src);img.alt=m.fileName;img.onload=()=>{$('messages').scrollTop=$('messages').scrollHeight};b.prepend(img)}).catch(()=>{});}c.append(meta,bubble);row.append(avatar,c);row.dataset.messageId=m.id;row.dataset.searchText=[m.text,m.fileName,speaker?.roleName,m.sender].filter(Boolean).join(' ').toLocaleLowerCase();row.dataset.roleAll=m.roleAll?'1':'0';row.dataset.roleReply=(m.roleReply||m.roleSender)?'1':'0';row.dataset.roleJobCount=String((m.roleJobs||(m.roleJob?[m.roleJob]:[])).length);const receipt=el('div','receipts');renderReceipts(receipt,m.recipients);c.append(receipt);for(const job of m.roleJobs||(m.roleJob?[m.roleJob]:[])){const status=el('div','role-status');status.dataset.roleJobId=job.message;renderRoleJob(status,job);c.append(status);}if(m.roleReply||m.roleSender)addReplyAction(row,m.id,(m.roleReply||m.roleSender).roleId);else if(!m.roleAll&&(m.roleJobs?.length||1)===1&&m.roleJob?.status==='replied')addReplyAction(row,m.id,m.roleJob.roleId);$('messages').append(row);}
let selection=0;async function selectRoom(id){if(id!==room)clearReply();const generation=++selection;room=id;$('messageQuery').value='';updateMessageSearch();renderRooms();$('roomTitle').textContent=rooms.find(r=>r.id===room)?.name||'请选择或创建群聊';try{await roleUI.refresh();if(!id){$('messages').replaceChildren(el('div','empty','请先创建群聊'));return;}const data=await get('/api/messages?room='+encodeURIComponent(id));if(generation!==selection)return;clearBlobs();seen=new Set();$('messages').replaceChildren(el('div','empty','还没有消息，打个招呼吧'));messages=data;messages.forEach(appendMessage);$('messages').scrollTop=$('messages').scrollHeight;if(!$('memberPanel').hidden)await Promise.all([refreshMembers(),refreshRoomRoles()]);}catch(e){$('notice').textContent=e.message;}}
async function reloadRooms(){rooms=await get('/api/rooms');renderRooms();}
async function refreshMembers(){const members=await get('/api/members');memberList=members;const selected=$('recipient').value;const none=el('option','','仅发群聊');none.value='';const all=el('option','','所有 Agent');all.value='all-agents';$('recipient').replaceChildren(none,all);for(const m of members.filter(m=>m.id!==me.id)){const o=el('option','',m.name+(m.kind==='agent'?' · Agent':''));o.value=m.id;$('recipient').append(o)}$('recipient').value=selected;$('memberCount').textContent=members.length;$('members').replaceChildren();for(const m of members){const row=el('div','member');row.append(memberAvatar(m.id,m.name,m.kind==='agent'));const d=el('div');d.append(el('span','',m.name),el('small','',m.kind==='agent'?'Agent':m.id===me.id?'你':'成员'));row.append(d);if(m.id===me.id||m.kind==='agent')row.append(avatarEditButton(m.id,m.name));$('members').append(row);}}
let availableRoles=[],roomRoles=[],capabilities=[];
function renderEfforts(){const role=availableRoles.find(r=>r.id===$('roomRoleSelect').value),source=capabilities.find(s=>s.owner===role?.owner&&s.provider===role?.provider),model=source?.models.find(m=>m.id===role.model),current=roomRoles.find(r=>r.id===role?.id)?.effort||'default';$('roomEffort').replaceChildren();for(const effort of ['default',...(model?.efforts||[])]){const option=el('option','',effort==='default'?'宿主默认':effort);option.value=effort;$('roomEffort').append(option);}$('roomEffort').value=[...$('roomEffort').options].some(o=>o.value===current)?current:'default';}
async function refreshRoomRoles(){if(!room){$('roomRoleCount').textContent='0';$('roomRoles').replaceChildren(el('p','member-empty','请选择群聊'));$('roomRoleSelect').replaceChildren();$('addRoomRole').disabled=true;return;}const target=room;const [all,joined,caps]=await Promise.all([get('/api/roles'),get('/api/rooms/'+encodeURIComponent(target)+'/roles'),get('/api/role-capabilities')]);if(room!==target)return;availableRoles=all;roomRoles=joined;capabilities=caps;const select=$('roomRoleSelect'),previous=select.value;select.replaceChildren();for(const r of all){const option=el('option','',r.name+' · '+(r.provider==='codex'?'Codex':'DSH')+' · '+r.id.slice(-6));option.value=r.id;select.append(option);}if(all.some(r=>r.id===previous))select.value=previous;renderEfforts();$('addRoomRole').disabled=!all.length;$('memberPanelRoom').textContent=$('roomTitle').textContent;$('roomRoleCount').textContent=joined.length;$('roomRoles').replaceChildren();if(!joined.length)$('roomRoles').append(el('p','member-empty','本群还没有角色'));for(const r of joined){const row=el('div','member'),label=el('div','member-label');label.append(el('span','',r.name),el('small','',(r.provider==='codex'?'Codex':'DSH')+' · '+(r.effort==='default'?'宿主默认':r.effort)));const remove=el('button','','移出');remove.type='button';remove.onclick=async()=>{try{await api('/api/rooms/'+encodeURIComponent(target)+'/roles/'+encodeURIComponent(r.id),{method:'DELETE'});await Promise.all([refreshRoomRoles(),roleUI.refresh()]);}catch(e){$('notice').textContent=e.message;}};remove.className='remove-room-role';const avatarId='role:'+r.id;row.append(memberAvatar(avatarId,r.name,true),label,avatarEditButton(avatarId,r.name),remove);$('roomRoles').append(row);}}
$('roomRoleSelect').onchange=renderEfforts;
$('addRoomRole').onclick=async()=>{if(!room||!$('roomRoleSelect').value)return;try{await post('/api/rooms/'+encodeURIComponent(room)+'/roles',{roleId:$('roomRoleSelect').value,effort:$('roomEffort').value});await Promise.all([refreshRoomRoles(),roleUI.refresh()]);}catch(e){$('notice').textContent=e.message;}};
async function connect(){controller?.abort();controller=new AbortController();const signal=controller.signal;while(!signal.aborted){try{const r=await api('/api/events',{signal});$('connection').textContent='实时连接';const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let idx;while((idx=buffer.indexOf('\n\n'))>=0){const part=buffer.slice(0,idx);buffer=buffer.slice(idx+2);if(!part.startsWith('data: '))continue;const e=JSON.parse(part.slice(6));if(e.type==='rooms')await reloadRooms();if(e.type==='members'){me=await get('/api/me');$('myName').textContent=me.name;await refreshMembers();if(room)await selectRoom(room);}if(e.type==='roles'||e.type==='room-roles'&&e.room===room){await roleUI.refresh();if(!$('memberPanel').hidden)await refreshRoomRoles();}if(e.type==='role-sources'&&!$('memberPanel').hidden)await refreshRoomRoles();if(e.type==='role-job'){const row=$('messages').querySelector('[data-message-id="'+Number(e.job.sourceMessage??e.job.message)+'"]');if(row){let node=row.querySelector('[data-role-job-id="'+Number(e.job.message)+'"]');if(!node){node=el('div','role-status');node.dataset.roleJobId=e.job.message;row.querySelector('.message-content').append(node);row.dataset.roleJobCount=String(Number(row.dataset.roleJobCount||0)+1);}if(Number(row.dataset.roleJobCount)>1&&row.dataset.roleReply!=='1')row.querySelector('.role-reply-action')?.remove();renderRoleJob(node,e.job);if(e.job.status==='replied'&&row.dataset.roleAll!=='1'&&Number(row.dataset.roleJobCount)===1)addReplyAction(row,e.job.sourceMessage??e.job.message,e.job.roleId);}}if(e.type==='receipt'){const node=$('messages').querySelector('[data-message-id="'+Number(e.messageId)+'"] .receipts');if(node)renderReceipts(node,e.receipts);}if(e.type==='message'&&e.message.room===room){const follow=isNearLatest();appendMessage(e.message);if(follow)scrollLatest();else updateJumpLatest();if(!$('messageSearch').hidden&&$('messageQuery').value.trim())updateMessageSearch();}}}}catch(e){if(signal.aborted)return;}if(signal.aborted)return;$('connection').textContent='正在重连';await new Promise(r=>setTimeout(r,2500));if(!signal.aborted){await roleUI.refresh().catch(()=>{});await selectRoom(room);}}}
async function login(){try{me=await get('/api/me');$('login').hidden=true;$('workspace').hidden=false;$('myName').textContent=me.name;await reloadRooms();await selectRoom(rooms[0]?.id||null);await refreshMembers();connect();}catch(e){$('loginError').textContent=e.message;}}
$('editName').onclick=()=>{$('newUserName').value=me.name;$('nameDialog').showModal();};$('nameDialog').onclose=async()=>{if($('nameDialog').returnValue!=='save')return;try{me=await(await api('/api/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('newUserName').value})})).json();$('myName').textContent=me.name;}catch(e){$('notice').textContent=e.message;}};
const messageList = $('messages');
let searchMatches = [];
let searchIndex = 0;

function isNearLatest() {
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
}

function updateJumpLatest() {
  $('jumpLatest').hidden = isNearLatest();
}

function scrollLatest() {
  messageList.scrollTop = messageList.scrollHeight;
  updateJumpLatest();
}

function showSearchMatch() {
  messageList.querySelector('.search-match')?.classList.remove('search-match');
  const match = searchMatches[searchIndex];
  const count = searchMatches.length;
  $('messageSearchCount').textContent = match ? (searchIndex + 1) + ' / ' + count : ($('messageQuery').value.trim() ? '无结果' : '');
  $('previousMatch').disabled = count < 2;
  $('nextMatch').disabled = count < 2;
  if (match) {
    match.classList.add('search-match');
    match.scrollIntoView({block:'center'});
  }
}

function updateMessageSearch() {
  const query = $('messageQuery').value.trim().toLocaleLowerCase();
  searchMatches = query ? Array.from(messageList.querySelectorAll('[data-search-text]')).filter(row => row.dataset.searchText.includes(query)) : [];
  searchIndex = Math.max(0, searchMatches.length - 1);
  showSearchMatch();
}

function moveSearchMatch(offset) {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex + offset + searchMatches.length) % searchMatches.length;
  showSearchMatch();
}

$('toggleMessageSearch').onclick = () => {
  const bar = $('messageSearch');
  bar.hidden = !bar.hidden;
  $('toggleMessageSearch').setAttribute('aria-expanded', String(!bar.hidden));
  if (!bar.hidden) $('messageQuery').focus();
  else {
    $('messageQuery').value = '';
    updateMessageSearch();
  }
};
$('messageQuery').oninput = updateMessageSearch;
$('messageQuery').onkeydown = event => {
  if (event.key === 'Enter') moveSearchMatch(event.shiftKey ? -1 : 1);
  if (event.key === 'Escape') {
    $('toggleMessageSearch').click();
    $('toggleMessageSearch').focus();
  }
};
$('previousMatch').onclick = () => moveSearchMatch(-1);
$('nextMatch').onclick = () => moveSearchMatch(1);
messageList.addEventListener('scroll', updateJumpLatest);
$('jumpLatest').onclick = scrollLatest;
$('backToRooms').onclick = () => {
  $('workspace').classList.remove('chat-open');
  if (!$('memberPanel').hidden) setMemberPanel(false);
  $('search').focus();
};

$('search').oninput=renderRooms;
function setMemberPanel(open) {
  $('memberPanel').hidden = !open;
  $('toggleMembers').setAttribute('aria-expanded', String(open));
  if (open) {
    $('memberPanelRoom').textContent = $('roomTitle').textContent;
    Promise.all([refreshMembers(), refreshRoomRoles()]).catch(error => {
      $('notice').textContent = error.message;
    });
  } else {
    $('toggleMembers').focus();
  }
}
$('toggleMembers').onclick = () => setMemberPanel($('memberPanel').hidden);
$('closeMembers').onclick = () => setMemberPanel(false);
$('addRoom').onclick=()=>$('roomDialog').showModal();$('roomDialog').onclose=async()=>{if($('roomDialog').returnValue!=='create')return;try{const r=await post('/api/rooms',{name:$('newRoomName').value});$('newRoomName').value='';await reloadRooms();await selectRoom(r.id)}catch(e){$('notice').textContent=e.message}};
function choose(file){if(file.size>25*1024*1024){$('notice').textContent='文件不能超过 25 MB';return}pending=file;$('filePreview').hidden=false;$('filePreview').replaceChildren(el('span','',file.name+' · '),el('button','','移除'));$('filePreview').querySelector('button').onclick=()=>{pending=null;$('filePreview').hidden=true;};}
$('pickFile').onclick=()=>$('file').click();$('file').onchange=()=>{if($('file').files[0])choose($('file').files[0]);$('file').value=''};$('draft').onpaste=e=>{const f=[...e.clipboardData.items].find(i=>i.kind==='file');if(f){e.preventDefault();choose(f.getAsFile())}};
$('clearDraft').onclick=()=>{clearReply();roleUI.clear();$('draft').value='';$('draft').focus()};
let sendAttempt=null;
function newMessageId(){const bytes=crypto.getRandomValues(new Uint8Array(16));return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
$('send').onclick=async()=>{
 if($('send').disabled)return;
 const text=$('draft').value.trim(),file=pending,target=room,roleId=roleUI.selected(),replyTo=replyContext?.messageId;
 if(!target){$('notice').textContent='请先创建或选择群聊';return;}
 if(replyContext&&(replyContext.roleId!==roleId||replyContext.room!==target)){$('notice').textContent='请重新选择要继续的角色，或取消回复';return;}
 if(!text&&!file)return;
 const recipients=$('recipient').value==='all-agents'?memberList.filter(m=>m.kind==='agent'&&m.id!==me.id).map(m=>m.id):$('recipient').value?[$('recipient').value]:[];
 const asDocument=$('asDocument').checked;const key=JSON.stringify({target,text,roleId,replyTo,recipients,asDocument});
 if(!sendAttempt||sendAttempt.key!==key||sendAttempt.file!==file)sendAttempt={key,file,id:newMessageId()};
 $('send').disabled=true;
 try{
  if(file&&!sendAttempt.fileId){$('notice').textContent='正在上传…';sendAttempt.fileId=(await(await api('/api/files?name='+encodeURIComponent(file.name),{method:'POST',body:file})).json()).id;}
  const m=await post('/api/messages',{room:target,text,fileId:sendAttempt.fileId,roleId,replyTo,recipients,asDocument,clientMessageId:sendAttempt.id});
  sendAttempt=null;$('asDocument').checked=false;if(room===target)appendMessage(m);$('draft').value='';clearReply();roleUI.clear();pending=null;$('filePreview').hidden=true;$('notice').textContent='Enter 发送 · Shift + Enter 换行';$('messages').scrollTop=$('messages').scrollHeight;
 }catch(e){$('notice').textContent=e.message;}finally{$('send').disabled=false;}
};
$('draft').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('send').click()}};login();

const receiptLabels={pending:'待送达',delivered:'已送达',read:'已读',processed:'已处理',dismissed:'已忽略'};
function renderReceipts(node,items){node.textContent=(items||[]).map(r=>r.name+' · '+(receiptLabels[r.status]||r.status)).join(' / ');}
$('recipient').onfocus=()=>refreshMembers().catch(()=>{});
