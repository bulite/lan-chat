import {createRoleUI,providerLabel,renderRoleJob} from './roles-ui.js?v=workspace-28';
const $=id=>document.getElementById(id);let me,room=null,rooms=[],pending=null,pendingSticker=null,controller,seen=new Set();
const compactComposer=matchMedia('(max-width:600px)');
const themeMode = $('themeMode');
const themePreference = matchMedia('(prefers-color-scheme: dark)');
try {
  const saved = localStorage.getItem('lan-chat:theme');
  if (saved === 'light' || saved === 'dark') themeMode.value = saved;
} catch {}

function applyTheme() {
  const mode = themeMode.value;
  document.documentElement.dataset.theme = mode === 'system' ? (themePreference.matches ? 'dark' : 'light') : mode;
}
themeMode.onchange = () => {
  try { localStorage.setItem('lan-chat:theme', themeMode.value); } catch {}
  applyTheme();
};
themePreference.addEventListener('change', applyTheme);
applyTheme();

async function api(p,options={}){const r=await fetch(p,{...options,headers:{...options.headers}});if(!r.ok){let e;try{e=(await r.json()).error}catch{e='请求失败'}throw Error(e);}return r;}
const get=async p=>(await api(p)).json();const post=async(p,b)=>(await api(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
const roleUI=createRoleUI({get,draft:$('draft'),getRoom:()=>room,onDraftChange:()=>sizeComposerDraft(),
  avatarForRole:role=>memberAvatar('role:'+role.id,role.name,role.id!=='__all__')});
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
const avatarOptions = ['🐱', '🦊', '🐼', '🐸', '🦉', '🤖', '👾', '🚀', '🐶', '🐰', '🐻', '🐯', '🐧', '🐙', '🐢', '🦄', '🌙', '⚡'];
const avatarStorageKey = 'lan-chat:member-avatars';
let memberAvatars = {};
const roleAvatars = new Map();
try {
  memberAvatars = JSON.parse(localStorage.getItem(avatarStorageKey) || '{}') || {};
} catch {}

function paintAvatar(node, id, name) {
  const choice = memberAvatars[id] ?? roleAvatars.get(id);
  node.replaceChildren();
  if (typeof choice === 'string' && /^asset:[a-zA-Z0-9-]+$/.test(choice)) {
    const image = el('img');
    image.src = '/api/assets/' + encodeURIComponent(choice.slice(6)) + '/content';
    image.alt = '';
    node.append(image);
  } else if (typeof choice === 'string' && /^data:image\/webp;base64,/.test(choice)) {
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

function setRoleAvatar(roleId, avatar) {
  const key='role:'+roleId;
  roleAvatars.set(key,avatar);
  for(const node of document.querySelectorAll('[data-avatar-id]')){
    if(node.dataset.avatarId===key)paintAvatar(node,key,node.dataset.avatarName);
  }
}

async function loadRoleAvatars() {
  const roles=await get('/api/roles');
  for(const role of roles)setRoleAvatar(role.id,role.avatar);
}

function memberAvatar(id, name, agent) {
  const node = el('span', 'avatar' + (agent ? ' agent' : ''));
  node.dataset.avatarId = id;
  node.dataset.avatarName = name;
  paintAvatar(node, id, name);
  return node;
}

function roleModelLabel(role) {
  if(role.provider!=='dsh')return role.model;
  try{
    const {provider,model}=JSON.parse(role.model);
    if(typeof provider==='string'&&typeof model==='string')return provider+' / '+model;
  }catch{}
  return role.model;
}

let roleDetailsRequest=0;
async function showRoleDetails(speaker) {
  const generation=++roleDetailsRequest, dialog=$('roleDetailsDialog'), fields=$('roleDetailsFields');
  const field=(label,value)=>[el('dt','',label),el('dd','',value)];
  const base=[...field('平台',providerLabel(speaker.provider)),...field('角色编号',speaker.roleId)];
  $('roleDetailsName').textContent=speaker.roleName;
  fields.replaceChildren(...base);
  $('roleDetailsStatus').textContent='正在读取模型…';
  dialog.showModal();
  try{
    const roles=await get('/api/roles');
    if(generation!==roleDetailsRequest||!dialog.open)return;
    const role=roles.find(item=>item.id===speaker.roleId);
    if(role){
      $('roleDetailsName').textContent=role.name;
      if(role.model)fields.append(...field('模型',roleModelLabel(role)));
    }
    $('roleDetailsStatus').textContent=role?'':'该角色已不在当前角色列表中';
  }catch(error){
    if(generation===roleDetailsRequest&&dialog.open)$('roleDetailsStatus').textContent=error.message;
  }
}

function messageAvatar(message,speaker) {
  const name=speaker?.roleName||message.sender;
  const avatar=memberAvatar(speaker?'role:'+speaker.roleId:message.senderId,name,message.kind==='agent'||Boolean(speaker));
  if(!speaker)return avatar;
  const button=el('button','message-role-avatar');
  button.type='button';
  button.setAttribute('aria-label','查看角色详情：'+name);
  button.setAttribute('aria-haspopup','dialog');
  avatar.setAttribute('aria-hidden','true');
  button.append(avatar);
  button.onclick=()=>showRoleDetails(speaker);
  return button;
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
  const shared = el('button', '', '共享头像');
  shared.type = 'button';
  shared.onclick = () => showAssetLibrary('avatar', asset => {
    if (dialog.open) save('asset:' + asset.id);
  });
  const reset = el('button', '', '恢复默认');
  reset.onclick = () => save(null);
  const close = el('button', '', '取消');
  close.onclick = () => dialog.close();
  actions.append(shared, upload, reset, close);
  dialog.append(heading, note, grid, file, status, actions);
  dialog.addEventListener('close', () => dialog.remove(), {once:true});
  document.body.append(dialog);
  dialog.showModal();
}

function assetImage(asset, className = '') {
  const image = el('img', className);
  image.src = '/api/assets/' + encodeURIComponent(asset.id) + '/content';
  image.alt = asset.name;
  image.loading = 'lazy';
  return image;
}

function showAssetLibrary(kind, select) {
  const title = kind === 'sticker' ? '共享表情' : '共享头像';
  const dialog = el('dialog', 'asset-dialog');
  dialog.setAttribute('aria-label', title);
  const header = el('header');
  const close = el('button', '', '关闭');
  close.type = 'button';
  close.onclick = () => dialog.close();
  header.append(el('h3', '', title), close);
  const grid = el('div', 'asset-grid'+(kind==='sticker'?' sticker-grid':''));
  grid.tabIndex=0;
  grid.setAttribute('aria-label',title+'列表');
  const thumbnails=new IntersectionObserver(entries=>{
    for(const {target,isIntersecting} of entries){
      if(!isIntersecting)continue;
      target.src=target.dataset.source;
      thumbnails.unobserve(target);
    }
  },{root:grid,rootMargin:'12px 0px'});
  const status = el('p', 'asset-status', '正在加载…');
  status.setAttribute('role', 'status');
  const upload = el('button', 'asset-upload', '上传到共享库');
  upload.type = 'button';
  const file = el('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/gif,image/webp';
  file.hidden = true;
  upload.onclick = () => file.click();
  function add(asset) {
    const button = el('button', 'asset-choice');
    button.type = 'button';
    button.setAttribute('aria-label', '使用 ' + asset.name);
    const image=el('img');
    image.alt='';
    image.decoding='async';
    image.dataset.source='/api/assets/'+encodeURIComponent(asset.id)+'/content';
    button.title=asset.name;
    button.append(image,el('span','',asset.name));
    button.onclick = () => { dialog.close(); select(asset); };
    grid.append(button);
    thumbnails.observe(image);
  }
  file.onchange = async () => {
    const image = file.files[0];
    file.value = '';
    if (!image) return;
    if (image.size > 2 * 1024 * 1024 || !['image/png','image/jpeg','image/gif','image/webp'].includes(image.type)) {
      status.textContent = '请选择 2 MiB 以内的 PNG、JPEG、GIF 或 WebP 图片。';
      return;
    }
    upload.disabled = true;
    status.textContent = '正在上传…';
    try {
      const asset = await (await api('/api/assets?kind=' + kind + '&name=' + encodeURIComponent(image.name),
        {method:'POST', body:image})).json();
      if (!dialog.open) return;
      add(asset);
      status.textContent = '已上传，点击图片即可使用。';
    } catch (error) {
      if (dialog.open) status.textContent = error.message;
    } finally { upload.disabled = false; }
  };
  dialog.append(header, grid, status, upload,
    el('p', 'asset-help', 'PNG、JPEG、GIF、WebP · 最大 2 MiB'), file);
  if(kind==='sticker'){
    const credit=el('p','asset-help','OpenMoji 表情来源 ');
    const source=el('a','','OpenMoji');
    source.href='https://openmoji.org/';
    source.target='_blank';
    source.rel='noopener noreferrer';
    const license=el('a','','CC BY-SA 4.0');
    license.href='https://creativecommons.org/licenses/by-sa/4.0/';
    license.target='_blank';
    license.rel='noopener noreferrer';
    credit.append(source,' · ',license,' · 原图');
    dialog.append(credit);
  }
  dialog.addEventListener('close',()=>{thumbnails.disconnect();dialog.remove();},{once:true});
  document.body.append(dialog);
  dialog.showModal();
  get('/api/assets?kind=' + kind).then(assets => {
    if (!dialog.open) return;
    assets.forEach(add);
    status.textContent = assets.length ? '' : '共享库暂无图片，可上传后使用。';
  }).catch(error => { if (dialog.open) status.textContent = error.message; });
}

let pendingPreviewUrl;
function clearPendingMedia() {
  if(pendingPreviewUrl)URL.revokeObjectURL(pendingPreviewUrl);
  pendingPreviewUrl=null;
  pending = pendingSticker = null;
  $('filePreview').hidden = true;
  $('filePreview').replaceChildren();
}
function showPendingMedia(name, thumbnail) {
  const preview=$('filePreview');
  const remove=el('button','','移除');
  remove.type='button';
  remove.onclick=clearPendingMedia;
  const label=el('span','pending-media-name',name);
  label.title=name;
  preview.replaceChildren(...(thumbnail?[thumbnail]:[]),label,remove);
  preview.hidden=false;
}
function selectSticker(asset) {
  clearPendingMedia();
  pendingSticker = asset;
  showPendingMedia(asset.name,assetImage(asset));
  setComposerOptions(false);
  $('draft').focus();
}
$('pickSticker').onclick = () => showAssetLibrary('sticker', selectSticker);

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

function parseRichMarkdown(content) {
  const env={};
  const tokens=markdown.parse(content,env);
  const structural=tokens.some(token=>!['paragraph_open','paragraph_close','inline'].includes(token.type));
  const inline=tokens.some(token=>token.children?.some(child=>!['text','softbreak'].includes(child.type)));
  return structural||inline?{tokens,env}:null;
}

function renderMarkdown(content, parsed) {
  const article = el('article', 'markdown-preview');
  article.innerHTML = parsed
    ? markdown.renderer.render(parsed.tokens,markdown.options,parsed.env)
    : markdown.render(content);
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

function messageName(message) {
  return message.roleReply?.roleName || message.roleSender?.roleName || message.sender;
}

const REACTION_EMOJIS = ['👍','👎','❤️','😂','😮','😢','🎉','🚀','👀','🔥','✅','❌','🙏','💯','🤔','😅','🫡','💪','☕','⚡'];
const reactionPicker = el('dialog', 'reaction-picker');
reactionPicker.setAttribute('aria-label', '选择回应表情');
document.body.append(reactionPicker);
reactionPicker.addEventListener('click', event => {
  if (event.target === reactionPicker) reactionPicker.close();
});

function reactionChip(group, message) {
  const mine = group.members.includes(me.id);
  const chip = el('button', 'reaction-chip' + (mine ? ' mine' : ''));
  chip.type = 'button';
  chip.setAttribute('aria-label', (mine ? '取消回应 ' : '回应 ') + group.emoji + '，已有 ' + group.count + ' 人');
  chip.append(el('span', 'reaction-emoji', group.emoji), el('span', 'reaction-count', String(group.count)));
  chip.onclick = () => toggleReaction(message, group.emoji);
  return chip;
}

function renderReactions(row, message) {
  let holder = row.querySelector('.reactions-row');
  const groups = message.reactions || [];
  if (!groups.length) {
    holder?.remove();
    return;
  }
  if (!holder) {
    holder = el('div', 'reactions-row');
    row.querySelector('.message-content').append(holder);
  }
  holder.replaceChildren(...groups.map(group => reactionChip(group, message)));
}

function refreshReactions(messageId, reactions) {
  const row = $('messages').querySelector('[data-message-id="' + Number(messageId) + '"]');
  if (!row) return;
  const remembered = quoteMessages.get(Number(messageId));
  if (remembered) remembered.reactions = reactions;
  renderReactions(row, {id:messageId, reactions});
}

async function toggleReaction(message, emoji) {
  try {
    const result = await post('/api/messages/' + message.id + '/reactions', {emoji});
    refreshReactions(message.id, result.reactions);
  } catch (error) {
    $('notice').textContent = error.message;
  }
}

function openReactionPicker(message, anchor) {
  reactionPicker.replaceChildren(...REACTION_EMOJIS.map(emoji => {
    const button = el('button', 'reaction-choice', emoji);
    button.type = 'button';
    button.setAttribute('aria-label', '回应 ' + emoji);
    button.onclick = () => {
      reactionPicker.close();
      toggleReaction(message, emoji);
    };
    return button;
  }));
  reactionPicker.style.removeProperty('left');
  reactionPicker.style.removeProperty('top');
  if (!reactionPicker.open) reactionPicker.showModal();
  if (!compactComposer.matches && anchor) {
    const bounds = reactionPicker.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    reactionPicker.style.left = Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8)) + 'px';
    reactionPicker.style.top = Math.max(8, Math.min(rect.bottom + 6, innerHeight - bounds.height - 8)) + 'px';
  }
}

async function copyMessage(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = el('textarea', 'clipboard-input');
  input.value = text;
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw Error('复制失败，请选择文字后复制');
  } finally { input.remove(); }
}

function showMessageMenu(message, position) {
  const heading = el('div', 'message-menu-heading');
  heading.append(el('strong', '', messageName(message)),
    el('p', '', message.text || message.assetName || message.fileName || '消息'));
  messageMenu.replaceChildren(heading);
  messageMenu.setAttribute('aria-label', '消息操作');
  const quickReactions = el('div', 'message-menu-reactions');
  for (const emoji of REACTION_EMOJIS.slice(0, 10)) {
    const button = el('button', 'reaction-choice', emoji);
    button.type = 'button';
    button.setAttribute('aria-label', '回应 ' + emoji);
    button.onclick = () => {
      messageMenu.close();
      toggleReaction(message, emoji);
    };
    quickReactions.append(button);
  }
  messageMenu.append(quickReactions);
  const actions = [
    ['引用', '“', () => chooseReply(message)],
    ...(message.text ? [
      ['复制文字', '⧉', () => copyMessage(message.text)],
      ['打开为 Markdown', 'M', () => showContent('消息全文', message.text, 'markdown')],
      ['打开为纯文本', 'T', () => showContent('消息全文', message.text)],
      ['另存为 Markdown', '↓', () => {
        const url = URL.createObjectURL(new Blob([message.text], {type:'text/markdown;charset=utf-8'}));
        const link = el('a');
        link.href = url;
        link.download = 'message-' + message.id + '.md';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }],
      ['转发…', '↗', () => forwardMessage(message)]
    ] : []),
    ['取消', '×', () => {}]
  ];
  for (const [label, icon, run] of actions) {
    const button = el('button', 'message-menu-action');
    button.type = 'button';
    const glyph = el('span', 'message-menu-icon', icon);
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph, el('span', '', label));
    button.onclick = async () => {
      messageMenu.close();
      try { await run(); }
      catch (error) { $('notice').textContent = error.message; }
    };
    messageMenu.append(button);
  }
  messageMenu.style.removeProperty('left');
  messageMenu.style.removeProperty('top');
  if (!messageMenu.open) messageMenu.showModal();
  if (!compactComposer.matches && position) {
    const bounds = messageMenu.getBoundingClientRect();
    messageMenu.style.left = Math.max(8, Math.min(position.x, innerWidth - bounds.width - 8)) + 'px';
    messageMenu.style.top = Math.max(8, Math.min(position.y, innerHeight - bounds.height - 8)) + 'px';
  }
}

function addMessageActions(node, message) {
  let timer, origin, longPressed = false;
  node.tabIndex = 0;
  node.setAttribute('aria-label', messageName(message) + ' 的消息，右键或长按打开操作');
  node.setAttribute('aria-haspopup', 'dialog');
  node.addEventListener('contextmenu', event => {
    event.preventDefault();
    clearTimeout(timer);
    showMessageMenu(message, {x:event.clientX, y:event.clientY});
  });
  node.addEventListener('pointerdown', event => {
    clearTimeout(timer);
    origin = null;
    longPressed = false;
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    origin = [event.clientX, event.clientY];
    timer = setTimeout(() => {
      longPressed = true;
      showMessageMenu(message, {x:origin[0], y:origin[1]});
    }, 550);
  });
  node.addEventListener('pointermove', event => {
    if (origin && Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 10) clearTimeout(timer);
  });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
    node.addEventListener(name, () => clearTimeout(timer));
  }
  node.addEventListener('click', event => {
    if (!longPressed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    longPressed = false;
  }, true);
  node.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      showMessageMenu(message, {x:rect.left, y:rect.bottom});
    }
  });
}

let replyContext = null;
const replyBanner = el('div', 'reply-context');
replyBanner.hidden = true;
$('filePreview').insertAdjacentElement('afterend', replyBanner);
function clearReply() {
  replyContext = null;
  replyBanner.hidden = true;
  replyBanner.replaceChildren();
}
function quoteText(message) {
  return message.text || message.assetName || message.fileName || '附件';
}
function chooseReply(message) {
  if (message.room !== room) return;
  const speaker = message.roleReply || message.roleSender;
  const row = $('messages').querySelector('[data-message-id="' + message.id + '"]');
  const jobs = Array.from(row?.querySelectorAll('[data-job-status]') || []).map(node => ({
    roleId:node.dataset.jobRoleId, status:node.dataset.jobStatus
  }));
  const roleId = speaker?.roleId || (!message.roleAll && jobs.length === 1 && jobs[0].status === 'replied' ? jobs[0].roleId : null);
  let continueRole = false;
  if (roleId) {
    try { roleUI.prepareReply(roleId); continueRole = true; }
    catch { /* Deleted or removed roles can still be quoted. */ }
  }
  replyContext = {messageId:message.id, roleId:roleUI.selected(), continueRole, room};
  const excerpt = el('div', 'reply-context-text');
  excerpt.append(el('strong', '', '引用 ' + messageName(message)), el('span', '', quoteText(message)));
  const cancel = el('button', '', '取消');
  cancel.type = 'button';
  cancel.onclick = clearReply;
  replyBanner.replaceChildren(excerpt, cancel);
  replyBanner.hidden = false;
  sizeComposerDraft();
  $('draft').focus();
}

const quoteMessages = new Map();
let quoteRoom = null;
function rememberMessage(message) {
  if (quoteRoom !== message.room) {
    quoteMessages.clear();
    quoteRoom = message.room;
  }
  quoteMessages.set(message.id, message);
}
function appendQuote(container, message) {
  if (!message.replyTo) return;
  const quote = el('button', 'message-quote');
  quote.type = 'button';
  const author = el('strong');
  const excerpt = el('span', 'message-quote-excerpt');
  const hint = el('small');
  hint.hidden = true;
  quote.title = '点击查看引用全文';
  quote.append(author, excerpt, hint);
  const cached = quoteMessages.get(message.replyTo);
  function paint(source) {
    author.textContent = source ? messageName(source) : '引用消息 #' + message.replyTo;
    excerpt.textContent = source ? quoteText(source) : '点击读取引用内容';
  }
  paint(cached);
  quote.onclick = async () => {
    quote.disabled = true;
    try {
      const source = quoteMessages.get(message.replyTo) ||
        await get('/api/messages/' + message.replyTo + '?room=' + encodeURIComponent(message.room));
      if (!quote.isConnected) return;
      if (source.room !== message.room) throw Error('引用消息不在当前群聊');
      if (quoteRoom === message.room) quoteMessages.set(source.id, source);
      paint(source);
      if (source.text) showContent(messageName(source) + ' · 引用消息', source.text, 'markdown');
      else if (source.assetId) showContent(source.assetName || '表情', '/api/assets/' + encodeURIComponent(source.assetId) + '/content', 'image');
      else if (source.fileId) await openAttachment(source);
    } catch (error) {
      hint.textContent = error.message;
      hint.hidden = false;
    } finally { quote.disabled = false; }
  };
  container.append(quote);
}

function renderAuditStatus(row, messageId, state) {
  row.querySelector('.audit-status')?.remove();
  const labels = {
    pending: '正在选择回复角色',
    failed: '未能判断回复角色',
    unavailable: '暂无可用回复角色',
    partial: '部分角色未能完成路由'
  };
  if (!Object.hasOwn(labels, state)) return;
  const status = el('div', 'audit-status', labels[state]);
  status.setAttribute('role', 'status');
  if (state !== 'pending' && me.kind === 'human') {
    const button = el('button', 'audit-target', '指定角色');
    button.type = 'button';
    button.onclick = async () => {
      const targetRoom = room;
      button.disabled = true;
      try {
        const roles = await get('/api/rooms/' + encodeURIComponent(targetRoom) + '/roles');
        if (room !== targetRoom || !status.isConnected) return;
        if (!roles.length) {
          $('notice').textContent = '请先为本群添加角色';
          return;
        }
        const select = el('select');
        select.setAttribute('aria-label', '选择要通知的角色');
        const placeholder = el('option', '', '选择角色');
        placeholder.value = '';
        select.append(placeholder);
        for (const role of roles) {
          const option = el('option', '', role.name + ' · ' + providerLabel(role.provider));
          option.value = role.id;
          select.append(option);
        }
        const dispatch = el('button', 'audit-target', '通知');
        dispatch.type = 'button';
        dispatch.disabled = true;
        select.onchange = () => { dispatch.disabled = !select.value; };
        dispatch.onclick = async () => {
          if (room !== targetRoom || !select.value) return;
          dispatch.disabled = select.disabled = true;
          try {
            const result = await post('/api/messages/' + messageId + '/route', { roleId: select.value });
            if (status.isConnected) renderAuditStatus(row, messageId, result.routeStatus);
          } catch (error) {
            $('notice').textContent = error.message;
          } finally {
            dispatch.disabled = select.disabled = false;
          }
        };
        button.replaceWith(select, dispatch);
        select.focus();
      } catch (error) {
        $('notice').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
    status.append(button);
  }
  row.querySelector('.message-content').append(status);
}
function renderRooms() {
  const list = $('rooms');
  const term = $('search').value.trim().toLocaleLowerCase();
  list.replaceChildren();
  for (const entry of rooms.filter(entry => entry.name.toLocaleLowerCase().includes(term))) {
    const button = el('button', 'room' + (entry.id === room ? ' active' : ''));
    button.type = 'button';
    if (entry.id === room) button.setAttribute('aria-current', 'true');
    const icon = el('span', 'avatar', '#');
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, el('strong', '', entry.name));
    button.onclick = () => openRoom(entry.id);
    list.append(button);
  }
  if (!list.children.length) {
    list.append(el('p', 'room-empty', term ? '没有匹配的群聊' : '还没有群聊'));
  }
}
function openRoom(id) {
  $('workspace').classList.add('chat-open');
  return selectRoom(id);
}
function groupMessage(row, message, speaker) {
  if (speaker || message.fileId || message.assetId || message.replyTo || message.asDocument ||
      message.text.length > 300 || message.recipients?.length || message.roleTarget) return;
  const previous = $('messages').lastElementChild;
  const created = Date.parse(message.created);
  row.dataset.simpleSender = message.senderId;
  row.dataset.created = created;
  const delta = created - Number(previous?.dataset.created);
  if (previous?.dataset.simpleSender === message.senderId && delta >= 0 && delta < 300000 &&
      new Date(message.created).toDateString() === new Date(Number(previous.dataset.created)).toDateString()) {
    row.classList.add('grouped');
  }
}
const activeRoleJobs=new Map();
let activeRoleLoad=null;
function renderActiveRoles(){
  const bar=$('activeRoleReplies');
  const roles=new Map([...activeRoleJobs.values()].map(job=>[job.roleId,job.roleName]));
  bar.replaceChildren(...[...roles.values()].map(name=>el('span','',name+' 正在回复')));
  bar.hidden=!roles.size;
}
function recordActiveRole(job){
  if(job.room!==room)return;
  if(job.status==='running')activeRoleJobs.set(job.message,job);
  else activeRoleJobs.delete(job.message);
  activeRoleLoad?.changes.set(job.message,job);
  renderActiveRoles();
}
async function loadActiveRoles(id){
  const load={changes:new Map()};
  activeRoleLoad=load;
  try{
    const running=id?await get('/api/rooms/'+encodeURIComponent(id)+'/active-roles'):[];
    if(activeRoleLoad!==load||room!==id)return;
    activeRoleJobs.clear();
    for(const job of running)activeRoleJobs.set(job.message,job);
    for(const job of load.changes.values()){
      if(job.status==='running')activeRoleJobs.set(job.message,job);
      else activeRoleJobs.delete(job.message);
    }
    renderActiveRoles();
  }finally{if(activeRoleLoad===load)activeRoleLoad=null;}
}
function renderTaskSummary() {
  const counts = new Map();
  for (const {dataset} of $('messages').querySelectorAll('[data-job-status]')) {
    const status = dataset.jobStatus === 'starting' ? 'pending' : dataset.jobStatus;
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const labels = {running: '处理中', pending: '待处理', failed: '失败'};
  const items = Object.entries(labels).filter(([status]) => counts.has(status)).map(([status, label]) => {
    const item = el('span', 'task-count', label + ' ' + counts.get(status));
    item.dataset.status = status;
    return item;
  });
  const summary = $('roomTasks');
  if (!items.length) items.push(el('p', 'member-empty', '暂无近期任务'));
  if (summary.textContent !== items.map(item => item.textContent).join('')) summary.replaceChildren(...items);
}
function renderMessageJob(node, job) {
  node.dataset.jobStatus = job.status;
  node.dataset.jobRoleId = job.roleId;
  node.dataset.jobRoleName = job.roleName;
  node.hidden = ['running','replied','dismissed'].includes(job.status);
  if(node.hidden)node.textContent='';
  else renderRoleJob(node, job);
}
const blobs=new Set();function clearBlobs(){for(const b of blobs)URL.revokeObjectURL(b);blobs.clear();}
async function fileBlob(id){const b=await(await api('/api/files/'+id)).blob();const u=URL.createObjectURL(b);blobs.add(u);return{b,u};}
function appendMessage(message, updateTasks = true) {
  if (seen.has(message.id)) return;
  seen.add(message.id);
  rememberMessage(message);
  $('messages').querySelector('.empty')?.remove();
  const row = el('article', 'message' + (message.senderId === me.id ? ' self' : ''));
  const speaker = message.roleReply || message.roleSender;
  const content = el('div', 'message-content');
  const meta = el('div', 'meta');
  meta.append(el('span', '', messageName(message)));
  if (message.kind === 'agent' && !speaker) meta.append(el('span', 'badge', 'AGENT'));
  meta.append(el('time', '', new Date(message.created).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'})));
  const imageFile=Boolean(message.fileId&&imageAttachment.test(message.fileName));
  const inlineMedia=Boolean(message.text&&(message.assetId||imageFile));
  const bubble = el('div', inlineMedia?'bubble contains-inline-media':'bubble');
  addMessageActions(bubble, message);
  if (message.recipients?.length) {
    bubble.append(el('div', 'directed', '通知 ' + message.recipients.map(recipient => recipient.name).join('、')));
  }
  if (message.text) {
    if (message.asDocument || message.text.length > 300) {
      const card = el('button', 'text-card');
      card.type = 'button';
      card.append(el('span', 'text-card-icon', '📄'), el('span', '', '文档 · ' + message.text.length + ' 字\n点击查看全文'));
      card.onclick = () => {
        const format=message.kind==='agent'||speaker||parseRichMarkdown(message.text)?'markdown':'text';
        showContent('消息全文',message.text,format);
      };
      bubble.append(card);
    } else {
      const rich=parseRichMarkdown(message.text);
      if(rich){
        const rendered=renderMarkdown(message.text,rich);
        rendered.classList.add('message-markdown');
        bubble.append(rendered);
      }else if(message.kind==='agent'||speaker){
        const text=el('button','agent-message-text',message.text);
        text.type='button';
        text.title='点击查看全文，右键或长按查看更多操作';
        text.onclick=()=>showContent('消息全文',message.text,'markdown');
        bubble.append(text);
      }else{
        bubble.append(el(inlineMedia?'span':'div','',message.text));
      }
    }
  }
  if (message.assetId) {
    const name=message.assetName||'表情';
    const button=el('button','message-sticker-button'+(inlineMedia?' inline-media-button':''));
    button.type='button';
    button.setAttribute('aria-label','查看表情：'+name);
    const image=assetImage({id:message.assetId,name},'message-sticker');
    button.append(image);
    button.onclick=()=>showContent(name,image.src,'image');
    bubble.append(button);
  } else if (message.fileId) {
    const attachment = el('button', 'attachment'+(imageFile?' image-attachment':'')+(inlineMedia?' inline-media-button':''));
    attachment.type = 'button';
    const hint = markdownAttachment.test(message.fileName) ? '预览 Markdown'
      : imageAttachment.test(message.fileName) ? '查看图片' : '下载文件';
    if(inlineMedia){
      attachment.title=message.fileName;
      attachment.setAttribute('aria-label','查看图片：'+message.fileName);
      attachment.append(el('span','inline-image-placeholder','▧'));
    }else{
      attachment.append(el('span', 'attachment-name', message.fileName),
        el('small', '', (message.fileSize / 1024).toFixed(1) + ' KB · ' + hint));
    }
    attachment.onclick = async () => {
      attachment.disabled = true;
      try { await openAttachment(message); }
      catch (error) { $('notice').textContent = error.message; }
      finally { attachment.disabled = false; }
    };
    bubble.append(attachment);
    if (imageFile) {
      fileBlob(message.fileId).then(({b:blob, u:url}) => {
        if (!row.isConnected) { URL.revokeObjectURL(url); return; }
        const image = el('img');
        const extension = message.fileName.split('.').at(-1).toLowerCase();
        const type = {png:'image/png', gif:'image/gif', webp:'image/webp', bmp:'image/bmp'}[extension] || 'image/jpeg';
        image.src = URL.createObjectURL(new Blob([blob], {type}));
        blobs.add(image.src);
        image.alt = message.fileName;
        image.onload = () => {
          if(inlineMedia)attachment.querySelector('.inline-image-placeholder')?.remove();
          if(isNearLatest())scrollLatest();
        };
        if(inlineMedia)image.onerror=()=>image.remove();
        attachment.prepend(image);
      }).catch(() => {});
    }
  }
  content.append(meta, bubble);
  appendQuote(content, message);
  row.append(messageAvatar(message, speaker), content);
  renderReactions(row, message);
  renderAuditStatus(row, message.id, message.routeStatus);
  row.dataset.messageId = message.id;
  row.dataset.searchText = [message.text, message.fileName, speaker?.roleName, message.sender].filter(Boolean).join(' ').toLocaleLowerCase();
  row.dataset.roleAll = message.roleAll ? '1' : '0';
  row.dataset.roleReply = speaker ? '1' : '0';
  const jobs = message.roleJobs || (message.roleJob ? [message.roleJob] : []);
  row.dataset.roleJobCount = String(jobs.length);
  const receipt = el('div', 'receipts');
  renderReceipts(receipt, message.recipients);
  content.append(receipt);
  for (const job of jobs) {
    const status = el('div', 'role-status');
    status.dataset.roleJobId = job.message;
    renderMessageJob(status, job);
    content.append(status);
  }
  groupMessage(row, message, speaker);
  appendDayDivider(message);
  addMessageTools(row, message);
  $('messages').append(row);
  if (updateTasks && jobs.length) renderTaskSummary();
}

let lastRenderedDay = null;
function dayLabel(date) {
  const now = new Date();
  const today = now.toDateString() === date.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString() === date.toDateString();
  if (today) return '今天';
  if (yesterday) return '昨天';
  return date.toLocaleDateString('zh-CN', {month: 'long', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric'});
}
function appendDayDivider(message) {
  const date = new Date(message.created);
  const key = date.toDateString();
  if (lastRenderedDay !== key) {
    lastRenderedDay = key;
    $('messages').append(el('div', 'day', dayLabel(date)));
  }
}

function addMessageTools(row, message) {
  const tools = el('div', 'message-tools');
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', '消息操作');
  const react = el('button', '', '☺');
  react.type = 'button';
  react.title = '添加回应';
  react.setAttribute('aria-label', '添加回应');
  react.onclick = event => openReactionPicker(message, event.currentTarget);
  const reply = el('button', '', '↩');
  reply.type = 'button';
  reply.title = '引用回复';
  reply.setAttribute('aria-label', '引用回复');
  reply.onclick = () => chooseReply(message);
  const more = el('button', '', '⋯');
  more.type = 'button';
  more.title = '更多操作';
  more.setAttribute('aria-label', '更多操作');
  more.onclick = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    showMessageMenu(message, {x:rect.left, y:rect.bottom + 6});
  };
  tools.append(react, reply, more);
  row.append(tools);
}
let selection = 0;
async function selectRoom(id) {
  const changed = id !== room;
  if (changed) {
    clearReply();
    roleUI.clear();
    clearBlobs();
    seen = new Set();
    $('messages').replaceChildren();
    $('roomRoles').replaceChildren();
    $('roomRoleCount').textContent = '';
    $('roomRoleSelect').replaceChildren();
    $('addRoomRole').disabled = true;
    renderTaskSummary();
    activeRoleJobs.clear();
    renderActiveRoles();
  }
  const generation = ++selection;
  room = id;
  void loadActiveRoles(id).catch(()=>{});
  if (changed) resetAuditorRoom();
  $('messageQuery').value = '';
  updateMessageSearch();
  renderRooms();
  $('roomTitle').textContent = rooms.find(entry => entry.id === room)?.name || '请选择或创建群聊';
  $('memberPanelRoom').textContent = id ? $('roomTitle').textContent : '';
  try {
    const [data] = await Promise.all([
      id ? get('/api/messages?room=' + encodeURIComponent(id)) : [],
      roleUI.refresh(),
      !$('memberPanel').hidden && refreshRoomRoles()
    ]);
    if (generation !== selection) return;
    clearBlobs();
    seen = new Set();
    $('messages').replaceChildren(el('div', 'empty', id ? '还没有消息，打个招呼吧' : '请先创建群聊'));
    lastRenderedDay = null;
    data.forEach(message => appendMessage(message, false));
    renderTaskSummary();
    scrollLatest();
  } catch (error) {
    if (generation === selection) $('notice').textContent = error.message;
  }
}
async function reloadRooms(){rooms=await get('/api/rooms');renderRooms();}
async function refreshMembers(){const members=await get('/api/members');$('memberCount').textContent=members.length;$('members').replaceChildren();for(const m of members){const row=el('div','member');row.append(memberAvatar(m.id,m.name,m.kind==='agent'));const d=el('div');d.append(el('span','',m.name),el('small','',m.kind==='agent'?'Agent':m.id===me.id?'你':'成员'));row.append(d);if(m.id===me.id||m.kind==='agent')row.append(avatarEditButton(m.id,m.name));$('members').append(row);}}
let availableRoles=[],roomRoles=[],capabilities=[];
function renderEfforts(){const role=availableRoles.find(r=>r.id===$('roomRoleSelect').value),source=capabilities.find(s=>s.owner===role?.owner&&s.provider===role?.provider),model=source?.models.find(m=>m.id===role.model),current=roomRoles.find(r=>r.id===role?.id)?.effort||'default';$('roomEffort').replaceChildren();for(const effort of ['default',...(model?.efforts||[])]){const option=el('option','',effort==='default'?'宿主默认':effort);option.value=effort;$('roomEffort').append(option);}$('roomEffort').value=[...$('roomEffort').options].some(o=>o.value===current)?current:'default';}
async function refreshRoomRoles(){if(!room){$('roomRoleCount').textContent='0';$('roomRoles').replaceChildren(el('p','member-empty','请选择群聊'));$('roomRoleSelect').replaceChildren();$('addRoomRole').disabled=true;return;}const target=room;const [all,joined,caps]=await Promise.all([get('/api/roles'),get('/api/rooms/'+encodeURIComponent(target)+'/roles'),get('/api/role-capabilities')]);if(room!==target)return;availableRoles=all;roomRoles=joined;capabilities=caps;const select=$('roomRoleSelect'),previous=select.value;select.replaceChildren();for(const r of all){const option=el('option','',r.name+' · '+providerLabel(r.provider)+' · '+r.id.slice(-6));option.value=r.id;select.append(option);}if(all.some(r=>r.id===previous))select.value=previous;renderEfforts();$('addRoomRole').disabled=!all.length;$('memberPanelRoom').textContent=$('roomTitle').textContent;$('roomRoleCount').textContent=joined.length;$('roomRoles').replaceChildren();if(!joined.length)$('roomRoles').append(el('p','member-empty','本群还没有角色'));for(const r of joined){const row=el('div','member'),label=el('div','member-label');label.append(el('span','',r.name),el('small','',providerLabel(r.provider)+' · '+(r.effort==='default'?'宿主默认':r.effort)));const remove=el('button','','移出');remove.type='button';remove.onclick=async()=>{try{await api('/api/rooms/'+encodeURIComponent(target)+'/roles/'+encodeURIComponent(r.id),{method:'DELETE'});await Promise.all([refreshRoomRoles(),roleUI.refresh()]);}catch(e){$('notice').textContent=e.message;}};remove.className='remove-room-role';const avatarId='role:'+r.id;row.append(memberAvatar(avatarId,r.name,true),label,avatarEditButton(avatarId,r.name),remove);$('roomRoles').append(row);}}
$('roomRoleSelect').onchange=renderEfforts;
$('addRoomRole').onclick=async()=>{if(!room||!$('roomRoleSelect').value)return;try{await post('/api/rooms/'+encodeURIComponent(room)+'/roles',{roleId:$('roomRoleSelect').value,effort:$('roomEffort').value});await Promise.all([refreshRoomRoles(),roleUI.refresh()]);}catch(e){$('notice').textContent=e.message;}};
async function connect(){controller?.abort();controller=new AbortController();const signal=controller.signal;while(!signal.aborted){try{const r=await api('/api/events',{signal});$('connection').textContent='实时连接';$('connection').dataset.state='connected';const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let idx;while((idx=buffer.indexOf('\n\n'))>=0){const part=buffer.slice(0,idx);buffer=buffer.slice(idx+2);if(!part.startsWith('data: '))continue;const e=JSON.parse(part.slice(6));if(e.type==='role-avatar')setRoleAvatar(e.roleId,e.avatar);if(e.type==='rooms'){await reloadRooms();if(room&&!rooms.some(entry=>entry.id===room))await selectRoom(rooms[0]?.id||null);}if(e.type==='members'){me=await get('/api/me');$('myName').textContent=me.name;await refreshMembers();if(room)await selectRoom(room);}if(e.type==='roles'||e.type==='room-roles'&&e.room===room){await roleUI.refresh();if(!$('memberPanel').hidden)await refreshRoomRoles();}if(e.type==='role-sources'&&!$('memberPanel').hidden)await refreshRoomRoles();if(e.type==='role-job'){recordActiveRole(e.job);const row=$('messages').querySelector('[data-message-id="'+Number(e.job.sourceMessage??e.job.message)+'"]');if(row){let node=row.querySelector('[data-role-job-id="'+Number(e.job.message)+'"]');if(!node){node=el('div','role-status');node.dataset.roleJobId=e.job.message;row.querySelector('.message-content').append(node);row.dataset.roleJobCount=String(Number(row.dataset.roleJobCount||0)+1);}renderMessageJob(node,e.job);renderTaskSummary();}}if(e.type==='audit-status'&&e.room===room){const row=$('messages').querySelector('[data-message-id="'+Number(e.messageId)+'"]');if(row)renderAuditStatus(row,e.messageId,e.routeStatus);}if(e.type==='reactions'&&e.room===room){refreshReactions(e.message,e.reactions);}if(e.type==='receipt'){const node=$('messages').querySelector('[data-message-id="'+Number(e.messageId)+'"] .receipts');if(node)renderReceipts(node,e.receipts);}if(e.type==='message'&&e.message.room===room){const follow=isNearLatest();appendMessage(e.message);if(follow)scrollLatest();else updateJumpLatest();if(!$('messageSearch').hidden&&$('messageQuery').value.trim())updateMessageSearch();}}}}catch(e){if(signal.aborted)return;}if(signal.aborted)return;$('connection').textContent='正在重连';delete $('connection').dataset.state;await new Promise(r=>setTimeout(r,2500));if(!signal.aborted){await roleUI.refresh().catch(()=>{});await loadRoleAvatars().catch(()=>{});await selectRoom(room);}}}
async function login(){try{me=await get('/api/me');$('login').hidden=true;$('workspace').hidden=false;$('myName').textContent=me.name;await reloadRooms();await loadRoleAvatars();await selectRoom(rooms[0]?.id||null);$('manageAuditors').hidden=me.kind!=='human';await refreshMembers();connect();}catch(e){$('loginError').textContent=e.message;}}
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
    (compactComposer.matches ? chatMenuButton : $('toggleMessageSearch')).focus();
  }
};
$('previousMatch').onclick = () => moveSearchMatch(-1);
$('nextMatch').onclick = () => moveSearchMatch(1);
messageList.addEventListener('scroll', updateJumpLatest);
$('jumpLatest').onclick = scrollLatest;
$('backToRooms').onclick = () => {
  $('workspace').classList.remove('chat-open');
  if (!desktopPanel.matches) setMemberPanel(false);
  $('search').focus();
};

$('search').oninput = renderRooms;
const auditorForm=$('auditorForm'), auditorDialog=$('auditorDialog');
let profiles=[], roomAuditorGeneration=0, profileGeneration=0, historyGeneration=0;

function auditorEndpoint(id){
  return '/api/rooms/'+encodeURIComponent(id)+'/auditor';
}
async function resetAuditorRoom(){
  const generation=++roomAuditorGeneration, target=room;
  const hidden=!target||me?.kind!=='human';
  $('removeRoom').hidden=$('roomAuditor').hidden=hidden;
  $('manageAuditors').hidden=me?.kind!=='human';
  const select=$('roomAuditorProfile'), save=$('saveRoomAuditor'), status=$('roomAuditorStatus');
  select.disabled=save.disabled=true;
  status.textContent='';
  if(hidden)return;
  try{
    const [available,current]=await Promise.all([get('/api/auditor-profiles'),get(auditorEndpoint(target))]);
    if(generation!==roomAuditorGeneration)return;
    select.replaceChildren(new Option('不使用统一审查员',''),...available.map(item=>new Option(item.name,item.id)));
    select.value=current.profileId||'';
    select.disabled=save.disabled=false;
  }catch(error){if(generation===roomAuditorGeneration)status.textContent=error.message;}
}
$('saveRoomAuditor').onclick=async()=>{
  const generation=roomAuditorGeneration, button=$('saveRoomAuditor'), status=$('roomAuditorStatus');
  button.disabled=true;
  try{
    await post(auditorEndpoint(room),{profileId:$('roomAuditorProfile').value||null});
    if(generation===roomAuditorGeneration)status.textContent='已应用';
  }catch(error){if(generation===roomAuditorGeneration)status.textContent=error.message;}
  finally{if(generation===roomAuditorGeneration)button.disabled=false;}
};
function setAuditorModels(models, selected=''){
  const select=$('auditorModel');
  select.replaceChildren(new Option('请选择模型',''),...[...new Set([selected,...models].filter(Boolean))].map(id=>new Option(id,id)));
  select.value=selected;
}
function editAuditor(){
  ++profileGeneration;
  const profile=profiles.find(item=>item.id===$('profilePicker').value);
  auditorForm.reset();
  $('auditorFields').disabled=false;
  $('profileName').value=profile?.name||'';
  $('auditorUrl').value=profile?.url||'';
  $('auditorContextLimit').value=profile?.contextLimit||8192;
  $('auditorRoutingBias').value=profile?.routingBias||'balanced';
  $('auditorApiKeyHint').textContent=profile?'留空沿用现有密钥。更换地址时请填写新密钥。':'填写模型服务提供的 API 密钥。';
  $('auditorStatus').textContent='';
  setAuditorModels([],profile?.model);
}
async function loadProfiles(selected=''){
  profiles=await get('/api/auditor-profiles');
  $('profilePicker').replaceChildren(new Option('新建配置',''),...profiles.map(item=>new Option(item.name,item.id)));
  $('profilePicker').value=selected;
  editAuditor();
}
async function loadAuditHistory(){
  const status=$('auditHistoryStatus');
  const generation=++historyGeneration, roomId=$('auditHistoryRoom').value;
  status.textContent='正在加载…';
  $('auditHistory').replaceChildren();
  try{
    const rows=await get('/api/audit-history'+(roomId?'?room='+encodeURIComponent(roomId):''));
    if(generation!==historyGeneration)return;
    const labels={pending:'排队中',claimed:'审查中',ignored:'无需派发或已取消',routed:'已派发',failed:'失败',unavailable:'无可用候选'};
    $('auditHistory').replaceChildren(...rows.map(row=>{
      const entry=el('details','audit-history-entry');
      entry.append(el('summary','',row.room+' · #'+row.message+' · '+(labels[row.status]||row.status)));
      const trace=row.trace, candidates=trace?.candidates||[];
      const selected=trace?.selected?.map(id=>candidates.find(role=>role.id===id)?.name||id)||[];
      const meta=[row.created?new Date(row.created).toLocaleString():'',row.model,trace?.stage].filter(Boolean).join(' · ');
      entry.append(el('p','',meta),el('p','',row.excerpt||'附件消息'));
      if(trace){
        entry.append(el('p','', '候选角色 '+(candidates.map(role=>role.name+' ('+providerLabel(role.provider)+')').join('、')||'无')),
          el('p','', '模型选择 '+(selected.join('、')||'无')));
        if(trace.historyCount!=null)entry.append(el('p','', '上下文 '+trace.historyCount+' 条近期消息'+(trace.hasSummary?'，另使用历史摘要':'')+(trace.compactions?'，压缩 '+trace.compactions+' 次':'')));
      }
      if(row.error||row.reason)entry.append(el('p','',row.error||row.reason));
      return entry;
    }));
    status.textContent=rows.length?'':'暂无审查记录';
  }catch(error){if(generation===historyGeneration)status.textContent=error.message;}
}
$('manageAuditors').onclick=()=>{
  $('auditorFields').disabled=true;
  auditorDialog.showModal();
  loadProfiles().catch(error=>{$('auditorStatus').textContent=error.message;});
  const filter=$('auditHistoryRoom'), previous=filter.value;
  filter.replaceChildren(new Option('所有群聊',''),...rooms.map(item=>new Option(item.name,item.id)));
  filter.value=rooms.some(item=>item.id===previous)?previous:'';
  void loadAuditHistory();
};
$('closeAuditors').onclick=()=>auditorDialog.close();
auditorDialog.onclose=()=>{++profileGeneration;auditorForm.reset();};
$('profilePicker').onchange=editAuditor;
$('refreshAuditHistory').onclick=loadAuditHistory;
$('auditHistoryRoom').onchange=loadAuditHistory;
$('auditorUrl').onchange=()=>setAuditorModels([]);
$('loadAuditorModels').onclick=async()=>{
  const url=$('auditorUrl').value.trim(), status=$('auditorStatus'), generation=profileGeneration;
  if(!url){status.textContent='请填写接口地址';return;}
  $('auditorFields').disabled=true;
  status.textContent='正在拉取模型…';
  try{
    const {models}=await post('/api/auditor-profiles/models',{id:$('profilePicker').value,url,apiKey:$('auditorApiKey').value.trim()});
    if(generation!==profileGeneration)return;
    const selected=$('auditorModel').value;
    setAuditorModels(models,models.includes(selected)?selected:'');
    status.textContent=models.length?'请选择模型':'接口没有返回可用模型';
  }catch(error){if(generation===profileGeneration)status.textContent=error.message;}
  finally{if(generation===profileGeneration)$('auditorFields').disabled=false;}
};
auditorForm.onsubmit=async event=>{
  event.preventDefault();
  const generation=profileGeneration, status=$('auditorStatus');
  $('auditorFields').disabled=true;
  try{
    const profile=await post('/api/auditor-profiles',{
      id:$('profilePicker').value,name:$('profileName').value,url:$('auditorUrl').value,
      model:$('auditorModel').value,routingBias:$('auditorRoutingBias').value,contextLimit:$('auditorContextLimit').valueAsNumber,apiKey:$('auditorApiKey').value.trim()
    });
    void resetAuditorRoom();
    if(generation!==profileGeneration)return;
    await loadProfiles(profile.id);
    status.textContent='已保存公共配置';
  }catch(error){if(generation===profileGeneration)status.textContent=error.message;}
  finally{if(generation===profileGeneration)$('auditorFields').disabled=false;}
};

let roomToRemove;
$('removeRoom').onclick=()=>{
  roomToRemove=rooms.find(entry=>entry.id===room);
  if(!roomToRemove)return;
  $('removeRoomForm').reset();
  $('removeRoomStatus').textContent='';
  $('removeRoomWarning').textContent='将永久删除「'+roomToRemove.name+'」及其消息和群设置。';
  $('removeRoomDialog').showModal();
};
$('cancelRemoveRoom').onclick=()=>$('removeRoomDialog').close();
$('removeRoomDialog').onclose=()=>$('removeRoomForm').reset();
$('removeRoomForm').onsubmit=async event=>{
  event.preventDefault();
  const target=roomToRemove, name=$('removeRoomName').value, button=$('confirmRemoveRoom');
  if(!target||name!==target.name){$('removeRoomStatus').textContent='请输入完整的群名称';return;}
  button.disabled=true;
  try{
    await api('/api/rooms/'+encodeURIComponent(target.id),{method:'DELETE',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name})});
    $('removeRoomDialog').close();
    await reloadRooms();
    if(room===target.id)await selectRoom(rooms[0]?.id||null);
  }catch(error){$('removeRoomStatus').textContent=error.message;}
  finally{button.disabled=false;}
};

$('toggleRoomSidebar').onclick = () => {
  const collapsed = $('workspace').classList.toggle('rooms-collapsed');
  const button = $('toggleRoomSidebar');
  button.setAttribute('aria-expanded', String(!collapsed));
  button.textContent = collapsed ? '展开群聊' : '折叠群聊';
};

const desktopPanel = matchMedia('(min-width: 1024px)');
function setMemberPanel(open, restoreFocus = false) {
  $('memberPanel').hidden = !open;
  $('toggleMembers').setAttribute('aria-expanded', String(open));
  $('toggleMembers').textContent = open ? '折叠协作' : '展开协作';
  if (open && me) {
    refreshRoomRoles().catch(error => { $('notice').textContent = error.message; });
  } else if (restoreFocus) {
    (compactComposer.matches ? chatMenuButton : $('toggleMembers')).focus();
  }
}
setMemberPanel(desktopPanel.matches);
desktopPanel.addEventListener('change', event => setMemberPanel(event.matches));
$('toggleMembers').onclick = () => {
  const open = $('memberPanel').hidden;
  setMemberPanel(open, !open);
  if (open) $('closeMembers').focus();
};
$('closeMembers').onclick = () => setMemberPanel(false, true);
$('memberPanel').addEventListener('keydown', event => {
  if (event.key === 'Escape') setMemberPanel(false, true);
});
$('addRoom').onclick=()=>$('roomDialog').showModal();$('roomDialog').onclose=async()=>{if($('roomDialog').returnValue!=='create')return;try{const r=await post('/api/rooms',{name:$('newRoomName').value});$('newRoomName').value='';await reloadRooms();await openRoom(r.id)}catch(e){$('notice').textContent=e.message}};
function choose(file){
  if(file.size>25*1024*1024){$('notice').textContent='文件不能超过 25 MB';return;}
  clearPendingMedia();
  pending=file;
  let thumbnail;
  if(/^(image\/(?:png|jpeg|gif|webp|bmp))$/.test(file.type)||imageAttachment.test(file.name)){
    pendingPreviewUrl=URL.createObjectURL(file);
    thumbnail=el('img');
    thumbnail.src=pendingPreviewUrl;
    thumbnail.alt='';
    thumbnail.onerror=()=>thumbnail.remove();
  }
  showPendingMedia(file.name,thumbnail);
  setComposerOptions(false);
  $('draft').focus();
}

$('pickFile').onclick=()=>$('file').click();$('file').onchange=()=>{if($('file').files[0])choose($('file').files[0]);$('file').value=''};$('draft').onpaste=e=>{const f=[...e.clipboardData.items].find(i=>i.kind==='file');if(f){e.preventDefault();choose(f.getAsFile())}};
const chatMenuButton=$('toggleChatMenu');
const chatHeader=chatMenuButton.closest('.chat-header');
function setChatMenu(open){
  chatMenuButton.setAttribute('aria-expanded',String(open));
  chatHeader.classList.toggle('menu-open',open);
}
chatMenuButton.onclick=()=>setChatMenu(!chatHeader.classList.contains('menu-open'));
for(const id of ['toggleMessageSearch','toggleMembers','backToRooms'])
  $(id).addEventListener('click',()=>setChatMenu(false));
document.addEventListener('click',event=>{
  if(!chatHeader.contains(event.target))setChatMenu(false);
});
chatHeader.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&chatHeader.classList.contains('menu-open')){
    setChatMenu(false);
    chatMenuButton.focus();
  }
});
const composerDraft=$('draft');
const optionsButton=$('toggleComposerOptions');
function sizeComposerDraft(){
  composerDraft.style.height='';
  if(compactComposer.matches)
    composerDraft.style.height=Math.max(42,Math.min(126,composerDraft.scrollHeight+2))+'px';
}
function setComposerOptions(open){
  optionsButton.setAttribute('aria-expanded',String(open));
  optionsButton.closest('.composer').classList.toggle('options-open',open);
}
$('previewMarkdownDraft').onclick=()=>{
  const text=composerDraft.value;
  if(!text.trim()){$('notice').textContent='先输入消息，再预览 Markdown';composerDraft.focus();return;}
  setComposerOptions(false);
  showContent('Markdown 预览',text,'markdown');
};
function wrapDraft(before, after = before, placeholder = '') {
  const start = composerDraft.selectionStart, end = composerDraft.selectionEnd;
  const selected = composerDraft.value.slice(start, end);
  const inner = selected || placeholder;
  composerDraft.setRangeText(before + inner + after, start, end, 'preserve');
  const innerStart = start + before.length;
  if (selected) composerDraft.setSelectionRange(innerStart, innerStart + inner.length);
  else composerDraft.setSelectionRange(innerStart + inner.length, innerStart + inner.length);
  composerDraft.focus();
  composerDraft.dispatchEvent(new Event('input', {bubbles:true}));
}
$('mdBold').onclick=()=>wrapDraft('**','**','粗体');
$('mdItalic').onclick=()=>wrapDraft('*','*','斜体');
$('mdStrike').onclick=()=>wrapDraft('~~','~~','删除线');
$('mdInlineCode').onclick=()=>wrapDraft('`','`','code');
$('mdCodeBlock').onclick=()=>wrapDraft('\n```\n','\n```\n','代码块');
$('clearMobileDraft').onclick=()=>{$('clearDraft').click();setComposerOptions(false);};
optionsButton.onclick=()=>setComposerOptions(optionsButton.getAttribute('aria-expanded')!=='true');
composerDraft.addEventListener('input',sizeComposerDraft);
compactComposer.addEventListener('change',()=>{setChatMenu(false);setComposerOptions(false);sizeComposerDraft();});
composerDraft.closest('.composer').addEventListener('keydown',event=>{
  if(event.key==='Escape'&&optionsButton.getAttribute('aria-expanded')==='true'){
    setComposerOptions(false);
    optionsButton.focus();
  }
});
$('clearDraft').onclick=()=>{clearPendingMedia();clearReply();roleUI.clear();$('draft').value='';sizeComposerDraft();$('draft').focus()};
let sendAttempt=null;
function newMessageId(){const bytes=crypto.getRandomValues(new Uint8Array(16));return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
$('send').onclick=async()=>{
 if($('send').disabled)return;
 const text=$('draft').value.trim(),file=pending,assetId=pendingSticker?.id,target=room,roleId=roleUI.selected(),replyTo=replyContext?.messageId;
 if(!target){$('notice').textContent='请先创建或选择群聊';return;}
 if(replyContext&&((replyContext.continueRole&&replyContext.roleId!==roleId)||replyContext.room!==target)){$('notice').textContent='请重新选择要继续的角色，或取消回复';return;}
 if(!text&&!file&&!assetId)return;
 const asDocument=$('asDocument').checked;const key=JSON.stringify({target,text,assetId,roleId,replyTo,asDocument});
 if(!sendAttempt||sendAttempt.key!==key||sendAttempt.file!==file)sendAttempt={key,file,id:newMessageId()};
 $('send').disabled=true;
 try{
  if(file&&!sendAttempt.fileId){$('notice').textContent='正在上传…';sendAttempt.fileId=(await(await api('/api/files?name='+encodeURIComponent(file.name),{method:'POST',body:file})).json()).id;}
  const m=await post('/api/messages',{room:target,text,fileId:sendAttempt.fileId,assetId,roleId,replyTo,asDocument,clientMessageId:sendAttempt.id});
  sendAttempt=null;$('asDocument').checked=false;if(room===target)appendMessage(m);$('draft').value='';sizeComposerDraft();setComposerOptions(false);clearReply();roleUI.clear();clearPendingMedia();$('notice').textContent='';$('messages').scrollTop=$('messages').scrollHeight;
 }catch(e){$('notice').textContent=e.message;}finally{$('send').disabled=false;}
};
$('draft').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('send').click()}};login();

const receiptLabels={pending:'待送达',delivered:'已送达',read:'已读',processed:'已处理',dismissed:'已忽略'};
function renderReceipts(node,items){node.textContent=(items||[]).map(r=>r.name+' · '+(receiptLabels[r.status]||r.status)).join(' / ');}
