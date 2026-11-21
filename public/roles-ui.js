const providerLabels = {codex: 'Codex', dsh: 'DSH', openclaw: 'OpenClaw'};
export function providerLabel(provider) {
  return Object.hasOwn(providerLabels, provider) ? providerLabels[provider] : 'Agent';
}

export function createRoleUI({get, draft, getRoom, avatarForRole, onDraftChange}) {
  let roles=[],selected=null,query=null,refreshGeneration=0;
  const menu=document.createElement('div');
  menu.className='role-menu';menu.hidden=true;menu.setAttribute('aria-label','选择角色');
  draft.insertAdjacentElement('beforebegin',menu);
  async function refresh(){
    const room=getRoom(),generation=++refreshGeneration;
    const next=room?await get('/api/rooms/'+encodeURIComponent(room)+'/roles'):[];
    if(generation!==refreshGeneration||room!==getRoom())return;
    roles=next;
    if(selected&&selected.id!=='__all__'&&!roles.some(r=>r.id===selected.id&&'@'+r.name===selected.label))selected=null;
    update();
  }
  function close(){menu.hidden=true;menu.replaceChildren();query=null;}
  function update(){
    if(selected&&draft.value.slice(selected.start,selected.start+selected.label.length)!==selected.label)selected=null;
    const cursor=draft.selectionStart,before=draft.value.slice(0,cursor),match=before.match(/(?:^|\s)@([^\s@]*)$/u);
    if(!match||selected){close();return;}
    const search=match[1].toLocaleLowerCase(),items=[...(roles.length?[{id:'__all__',name:'全体',provider:'all'}]:[]),...roles].filter(r=>r.name.toLocaleLowerCase().includes(search));
    query={start:cursor-match[1].length-1,end:cursor};menu.replaceChildren();
    for(const role of items){
      const button=document.createElement('button');
      button.type='button';
      if(role.id==='__all__')button.title='通知当前群内所有角色';
      const avatar=avatarForRole(role);
      avatar.setAttribute('aria-hidden','true');
      const name=document.createElement('span');
      name.className='role-menu-name';
      name.textContent=role.name;
      button.append(avatar,name);
      button.addEventListener('mousedown',e=>e.preventDefault());
      button.addEventListener('click',()=>{
        if(!query)return;const label='@'+role.name;
        draft.setRangeText(label+' ',query.start,query.end,'end');selected={id:role.id,label,start:query.start};close();onDraftChange();draft.focus();
      });menu.append(button);
    }
    menu.hidden=items.length===0;
  }
  draft.addEventListener('input',update);draft.addEventListener('click',update);
  draft.addEventListener('keydown',e=>{if(!menu.hidden&&e.key==='Escape'){close();e.stopImmediatePropagation();}else if(!menu.hidden&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();e.stopImmediatePropagation();menu.querySelector('button')?.click();}},true);
  function prepareReply(roleId){
    const role=roles.find(r=>r.id===roleId);if(!role)throw Error('角色已删除，无法继续此会话');
    const label='@'+role.name;
    const rest=selected&&draft.value.slice(selected.start,selected.start+selected.label.length)===selected.label
      ?draft.value.slice(0,selected.start)+draft.value.slice(selected.start+selected.label.length).trimStart():draft.value;
    draft.value=label+' '+rest;
    selected={id:role.id,label,start:0};close();onDraftChange();draft.focus();draft.setSelectionRange(draft.value.length,draft.value.length);
    return role;
  }
  return {refresh,selected:()=>selected?.id,prepareReply,clear:()=>{selected=null;close();},update};
}

const labels={pending:'等待处理',starting:'等待处理',running:'处理中',replied:'已回复',dismissed:'无需回复',failed:'失败'};
export function renderRoleJob(node,job){
  if(!job)return;
  node.textContent=job.roleName+' · '+(labels[job.status]||job.status)+(job.error?'：'+job.error:'');
}
