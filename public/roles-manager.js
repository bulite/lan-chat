const $=id=>document.getElementById(id);
let sources=[],roles=[],editing=null,busy=false;
const api=async(path,method='GET',body)=>{const r=await fetch(path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||'请求失败');return v;};
const source=()=>sources.find(s=>s.provider===$('provider').value);
function reset(){editing=null;$('roleName').value='';$('roleModel').value='';$('saveRole').textContent='创建角色';$('cancelEdit').hidden=true;}
function render(){
 const selected=$('roleModel').value,src=source();$('roleModel').replaceChildren(new Option('请选择模型',''));
 for(const model of src?.models||[])$('roleModel').add(new Option(model.name,model.id));$('roleModel').value=selected;
 $('roleList').replaceChildren();
 for(const role of roles.filter(r=>r.provider===$('provider').value&&r.owner===src?.owner)){
  const row=document.createElement('div');row.className='roles-row';const info=document.createElement('div');const title=document.createElement('strong');title.textContent=role.name;const model=document.createElement('small');model.textContent=src.models.find(m=>m.id===role.model)?.name||'已不可用的模型';info.append(title,model);
  const edit=document.createElement('button');edit.textContent='修改';edit.onclick=()=>{editing=role.id;$('roleName').value=role.name;$('roleModel').value=role.model;$('saveRole').textContent='保存修改';$('cancelEdit').hidden=false;};
  const remove=document.createElement('button');remove.textContent='删除';remove.onclick=async()=>{if(busy)return;busy=true;try{await api('/api/managed-roles/'+encodeURIComponent(role.id),'DELETE');if(editing===role.id)reset();await refresh();$('roleNotice').textContent='角色已删除';}catch(e){$('roleNotice').textContent=e.message}finally{busy=false}};
  row.append(info,edit,remove);$('roleList').append(row);
 }
 if(!src)$('roleNotice').textContent='等待 '+($('provider').value==='codex'?'Codex':'DSH')+' 插件提供模型列表';
}
async function refresh(){try{[sources,roles]=await Promise.all([api('/api/role-sources'),api('/api/roles')]);$('roleNotice').textContent='';render();}catch(e){$('roleNotice').textContent=e.message;}}
$('provider').onchange=()=>{reset();render()};$('cancelEdit').onclick=reset;$('refreshRoles').onclick=refresh;
$('saveRole').onclick=async()=>{if(busy)return;const src=source(),name=$('roleName').value.trim(),model=$('roleModel').value;if(!src||!name||!model){$('roleNotice').textContent='请填写名称并选择可用模型';return;}busy=true;try{if(editing)await api('/api/managed-roles/'+encodeURIComponent(editing),'PATCH',{name,model});else await api('/api/managed-roles','POST',{name,model,owner:src.owner,provider:src.provider});reset();await refresh();$('roleNotice').textContent='角色已保存';}catch(e){$('roleNotice').textContent=e.message}finally{busy=false}};
const provider=new URL(location.href).searchParams.get('provider');if(['codex','dsh'].includes(provider))$('provider').value=provider;
refresh();
