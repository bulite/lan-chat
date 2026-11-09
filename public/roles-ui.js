export function createRoleUI({get, draft, getRoom}) {
  let roles=[],selected=null,query=null;
  const menu=document.createElement('div');
  menu.className='role-menu';menu.hidden=true;menu.setAttribute('aria-label','选择角色');
  draft.insertAdjacentElement('beforebegin',menu);
  async function refresh(){
    roles=getRoom()?await get('/api/rooms/'+encodeURIComponent(getRoom())+'/roles'):[];
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
      let model=role.model;if(role.provider==='dsh'){try{const m=JSON.parse(role.model);model=m.provider+' / '+m.model;}catch{}}
      const button=document.createElement('button');button.type='button';button.textContent=role.id==='__all__'?'全体 · 当前群内所有角色':role.name+' · '+(role.provider==='codex'?'Codex':'DSH')+' · '+model+' · '+role.id.slice(-6);
      button.addEventListener('mousedown',e=>e.preventDefault());
      button.addEventListener('click',()=>{
        if(!query)return;const label='@'+role.name;
        draft.setRangeText(label+' ',query.start,query.end,'end');selected={id:role.id,label,start:query.start};close();draft.focus();
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
    selected={id:role.id,label,start:0};close();draft.focus();draft.setSelectionRange(draft.value.length,draft.value.length);
    return role;
  }
  return {refresh,selected:()=>selected?.id,prepareReply,clear:()=>{selected=null;close();},update};
}

const labels={pending:'等待处理',starting:'等待处理',running:'处理中',replied:'已回复',dismissed:'无需回复',failed:'失败'};
export function renderRoleJob(node,job){
  if(!job)return;
  node.textContent=job.roleName+' · '+(job.provider==='codex'?'Codex':'DSH')+' · '+job.roleId.slice(-6)+' · '+(labels[job.status]||job.status)+(job.error?'：'+job.error:'');
}
