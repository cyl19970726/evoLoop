import { renderPlainSvg } from './plain-svg.js';
import { sourceUrl } from './viewer.js';
export const STRUCTURE_ALIASES = { ports: 'contracts' };
const routes = {
  'responsibility-to-entry': { points:[[210,116],[270,116]], label:'判断与授权', at:[240,102] },
  'entry-to-api': { points:[[440,116],[510,116]], label:'受控入口', at:[475,102] },
  'api-to-core': { points:[[665,116],[730,116]], label:'校验', at:[697,102] },
  'core-to-adapters': { points:[[815,152],[815,230],[702,230],[702,290]], label:'经注入端口调用', at:[752,218] },
  'core-to-ports': { points:[[900,116],[960,116]], label:'依赖', at:[930,102], kind:'reference' },
  'adapters-to-ports': { points:[[815,328],[1045,328],[1045,152]], label:'实现端口', at:[1045,240], kind:'reference' },
  'adapters-to-postgres': { points:[[620,366],[620,400],[145,400],[145,535]], label:'同库事务读写', at:[280,388] },
  'adapters-to-wiki': { points:[[665,366],[665,430],[365,430],[365,535]], label:'固定修订读取／审阅后发布', at:[455,418] },
  'adapters-to-git': { points:[[700,366],[700,470],[585,470],[585,535]], label:'固定 commit 只读', at:[645,458] },
  'adapters-to-codex': { points:[[740,366],[740,430],[805,430],[805,535]], label:'派发／回读', at:[805,418] },
  'adapters-to-feishu': { points:[[780,366],[780,400],[1045,400],[1045,535]], label:'任务投影', at:[985,388] },
  'feishu-edit-to-adapters': { points:[[1130,571],[1170,571],[1170,380],[850,380],[850,348],[815,348]], label:'编辑观察', at:[1125,368], kind:'feedback' },
  'inbound-command-to-api': { points:[[590,328],[550,328],[550,220],[587,220],[587,152]], label:'带身份／基线的命令', at:[448,245], kind:'feedback' },
};
export function structureDiagram(architecture, { expanded = false } = {}) {
  if (!expanded) {
    const external = ['postgres','wiki-service','git-repos','codex','feishu'];
    const lookup = new Map(architecture.components.map(n => [n.id,n]));
    const shortContext={postgres:'Task／Document 主数据',codex:'Thread／Turn 历史'};
    const nodes = ['actors','entry',...external].map(id => {
      const n=lookup.get(id), index=external.indexOf(id);
      return {id,label:n.label,lines:id==='entry'?['人：工作台观察与反馈','Agent：业务 skill → CLI']:[shortContext[id]||n.sublabel],x:id==='actors'?30:id==='entry'?310:30+index*205,y:index<0?80:310,w:index<0?205:180,h:index<0?90:100};
    });
    nodes.push({id:'coordinator',x:650,y:65,w:360,h:120,label:'同一协调进程 · 本机切片',lines:['共同 API · core 业务用例','中立合同与端口 · 适配器装配']});
    const edges = [
      {id:'responsibility-to-entry',from:'actors',to:'entry',points:[[235,125],[310,125]],label:'判断／授权',at:[272,110]},
      {id:'entry-to-api',from:'entry',to:'coordinator',points:[[515,125],[650,125]],label:'受控命令／查询',at:[582,110]},
      ...[
        ['adapters-to-postgres',690,215,120,'同库事务读写',280],
        ['adapters-to-wiki',720,240,325,'固定修订读／审阅后发布',450],
        ['adapters-to-git',750,265,530,'固定 commit 只读',640],
        ['adapters-to-codex',810,240,735,'派发／回读',790],
        ['adapters-to-feishu',900,215,940,'Task 投影',950],
      ].map(([id,x,y,end,label,labelX],index)=>({id,from:'coordinator',to:external[index],points:[[x,185],[x,y],[end,y],[end,310]],label,at:[labelX,y-12]})),
      {id:'feishu-edit-to-adapters',from:'feishu',to:'coordinator',points:[[1030,360],[1048,360],[1048,195],[1020,195],[1020,145],[1010,145]],label:'编辑后受控核验',at:[1015,285],kind:'feedback'},
    ];
    return {title:'evoLoop 系统结构 · 目标设计',description:'人类工作台与 Agent 的业务 skill/CLI 共用同一协调进程；进程装配核心、接口与适配器，连接五个各守权威的外部边界。展开协调进程可查看内部装配。',width:1060,height:445,nodes,edges,groups:[]};
  }
  const nodes = architecture.components.map(node => ({ id:node.id, x:node.pos[0], y:node.pos[1], w:node.size[0], h:node.size[1], label:node.label, lines:node.id==='entry'?['人：工作台','Agent：业务 skill → CLI']:[node.sublabel], dashed:['actors','ports'].includes(node.id) }));
  const byId = new Map(nodes.map(node => [node.id,node]));
  const groups = architecture.boundaries.map(boundary => {
    const members = boundary.wraps.map(id => byId.get(id));
    const x=Math.min(...members.map(n=>n.x))-20, y=Math.min(...members.map(n=>n.y))-20;
    return { x,y,w:Math.max(...members.map(n=>n.x+n.w))+20-x,h:Math.max(...members.map(n=>n.y+n.h))+20-y,label:boundary.label };
  });
  const edges = architecture.connections.map(edge => {
    if (!routes[edge.id]) throw new Error(`Structural route missing: ${edge.id}`);
    return {...edge,...routes[edge.id]};
  });
  return { title:'evoLoop 系统结构 · 目标设计', description:'人类经工作台观察，Agent 经业务 skill/CLI 执行，共用受控 API；协调进程装配 core、合同与适配器。PG、外置 Wiki、Git、运行时与飞书各有边界。虚线连线表示代码接口依赖，端口不是运行服务。',width:1200,height:645,nodes,edges,groups };
}
function el(tag, text, cls) { const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n; }
export function parseStructureState(model,hash='') {
  const p=new URLSearchParams(hash.replace(/^#/,'')); const ids=new Set(model.nodes.map(n=>n.id));
  return { scope:ids.has(p.get('scope'))?p.get('scope'):null, expanded:new Set(p.getAll('expand').filter(id=>ids.has(id))) };
}
export function mountStructure(root,model,architecture,{onExplore,documentationHref}={}) {
  const byId=new Map(model.nodes.map(n=>[n.id,n]));const children=new Map(model.nodes.map(n=>[n.id,model.nodes.filter(c=>c.parent===n.id)]));
  let state=parseStructureState(model,location.hash), renderedHash;
  function update() { const p=new URLSearchParams({view:'structure'});if(state.scope)p.set('scope',state.scope);for(const id of state.expanded)p.append('expand',id);location.hash=p.toString();render(); }
  function sourceList(node,parent) {
    const list=el('div',null,'structure-sources');
    for(const s of node.sources){const a=el('a',`${s.path}:${s.line}`);a.href=sourceUrl(model,s);a.target='_blank';a.rel='noopener noreferrer';list.append(a);}
    parent.append(list);
  }
  function tree(node,depth=0) {
    const branch=el('div',null,'structure-branch');branch.dataset.structureBranch=node.id;
    const descendants=children.get(node.id);const row=el('div',null,'structure-child-row');
    if(descendants.length){const toggle=el('button',`${state.expanded.has(node.id)?'−':'＋'} ${node.label}`);toggle.type='button';toggle.setAttribute('aria-expanded',String(state.expanded.has(node.id)));toggle.addEventListener('click',()=>{state.expanded.has(node.id)?state.expanded.delete(node.id):state.expanded.add(node.id);update();root.querySelector(`[data-structure-branch="${node.id}"] button`)?.focus({preventScroll:true});});row.append(toggle);}
    else row.append(el('strong',node.label));
    if(node.path)row.append(el('code',node.path));
    branch.append(row,el('p',node.summary));
    if(state.expanded.has(node.id))for(const child of descendants)branch.append(tree(child,depth+1));
    const more=el('details',null,'structure-node-facts');more.append(el('summary','来源、字段与关系'));
    for(const f of node.details||[])more.append(el('p',`${f.label}：${f.value}`));sourceList(node,more);
    const link=el('button','在完整关系索引中定位 ↗');link.type='button';link.addEventListener('click',()=>onExplore(node.id));more.append(link);branch.append(more);
    return branch;
  }
  function render() {
    renderedHash=location.hash;
    root.replaceChildren();root.className='structure-view';
    root.append(el('p','先看责任、协调进程与外部权威；展开进程查看装配，点选组件继续查看子模块。','structure-intro'));
    const figure=el('div',null,'structure-canvas');figure.innerHTML=renderPlainSvg(structureDiagram(architecture,{expanded:state.expanded.has('coordinator')}),{interactive:true,selected:Object.entries(STRUCTURE_ALIASES).find(([,v])=>v===state.scope)?.[0]||state.scope});
    const activate=target=>{const id=STRUCTURE_ALIASES[target.dataset.structureNode]||target.dataset.structureNode;if(id==='coordinator')state.expanded.add('coordinator');state.scope=state.scope===id?null:id;update();if(state.scope)requestAnimationFrame(()=>root.querySelector('.structure-detail-bar')?.scrollIntoView({behavior:'smooth',block:'start'}));};
    figure.addEventListener('click',e=>{const n=e.target.closest('[data-structure-node]');if(n)activate(n);});
    figure.addEventListener('keydown',e=>{if(!['Enter',' '].includes(e.key))return;const n=e.target.closest('[data-structure-node]');if(n){e.preventDefault();activate(n);root.querySelector(`[data-structure-node="${n.dataset.structureNode}"]`)?.focus({preventScroll:true});}});
    root.append(figure);
    const controls=el('div',null,'structure-controls');
    const process=el('button',`${state.expanded.has('coordinator')?'− 收起':'＋ 展开'}协调进程装配`);process.type='button';process.setAttribute('aria-expanded',String(state.expanded.has('coordinator')));process.addEventListener('click',()=>{state.expanded.has('coordinator')?state.expanded.delete('coordinator'):state.expanded.add('coordinator');update();});controls.append(process);
    for(const [id,label] of [['coordinator','装配与恢复循环'],['support','开发工具与验证夹具']]){const b=el('button',`${state.scope===id?'−':'＋'} ${label}`);b.type='button';b.addEventListener('click',()=>{state.scope=state.scope===id?null:id;update();});controls.append(b);}
    controls.append(el('span',state.expanded.has('coordinator')?'虚线连线＝代码接口依赖；实线＝受控调用、读写或观察。':'实线＝受控调用、读写或观察；进程可展开查看内部装配。'));root.append(controls);
    if(state.scope){const node=byId.get(state.scope);const pane=el('section',null,'structure-detail');const bar=el('div',null,'structure-detail-bar');bar.append(el('h2',node.label));const close=el('button','收起本层');close.type='button';close.addEventListener('click',()=>{state.scope=null;update();});bar.append(close);pane.append(bar,el('p',node.summary));
      if(node.path)pane.append(el('code',node.path));
      if(node.id==='coordinator'){const composition=el('div',null,'structure-composition');for(const [id,label] of [['core','展开 core 业务模块'],['contracts','展开合同与端口'],['adapters','展开适配器包']]){const b=el('button',label);b.type='button';b.addEventListener('click',()=>{state.scope=id;update();});composition.append(b);}pane.append(composition);}
      const list=children.get(node.id);if(list.length){const levels=el('div',null,'structure-levels');for(const child of list)levels.append(tree(child));pane.append(levels);}else{for(const f of node.details||[])pane.append(el('p',`${f.label}：${f.value}`));}
      sourceList(node,pane);root.append(pane);
    }
    const navigation=el('nav',null,'structure-context');navigation.append(el('span','阅读所在：架构总览 §2「四部分如何组成系统」'));
    const a=el('a','返回架构正文 ↗');a.href=documentationHref('2-四部分如何组成系统');navigation.append(a);root.append(navigation);
  }
  window.addEventListener('hashchange',()=>{if(location.hash===renderedHash)return;const p=new URLSearchParams(location.hash.slice(1));if(p.get('view')==='structure'||!location.hash){state=parseStructureState(model,location.hash);render();}});render();
}
