import { mountArchitectureViewer, validateModel } from './viewer.js';
import { mountSystemReading, READING_MECHANISMS } from './reading.js';
import { mountStructure } from './structure.js';

export function pageView(hash = '') {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('view') === 'structure') return 'structure';
  if (params.has('read')) return 'reading';
  return ['open', 'node', 'mode', 'journey', 'zoom'].some(key => params.has(key)) ||
    params.get('view') === 'modules' ? 'modules' : 'structure';
}
export function documentationHref(anchor, model, page = 'overview') {
  return location.protocol !== 'file:' || location.pathname.includes('/site/')
    ? `../architecture/${page}.html#${anchor}`
    : `${model.repository.url}/blob/${model.repository.revision}/docs/architecture/${page}.md#${anchor}`;
}
export function mountSystemApp(root, model, architecture) {
  validateModel(model);
  root.className = 'system-app';
  const create = (tag, className, text) => { const n=document.createElement(tag);n.className=className;if(text)n.textContent=text;return n; };
  const header=create('header','system-header');const identity=create('div','system-identity');
  identity.append(create('span','system-name','evoLoop'),create('span','system-status','目标设计 · 业务系统尚未实现'));
  const title=create('h1','','系统结构');
  const controls=create('nav','system-views');controls.setAttribute('aria-label','架构阅读层次');
  const structureButton=create('button','','系统结构'), moduleButton=create('button','','完整模块 · 12 个拟议包'), current=create('span','system-current-mechanism');
  structureButton.type=moduleButton.type='button';controls.append(structureButton,moduleButton,current);
  const refs=create('details','system-sources');refs.append(create('summary','','图源与版本'));const list=create('div','system-source-list');
  for(const [label,href] of [['结构图规范','evoloop-system-structure.architecture.json'],['模块与关系模型','evoloop-system.model.json'],['固定模块来源 · '+model.repository.revision.slice(0,12),`${model.repository.url}/tree/${model.repository.revision}`]]){const a=create('a','',label);a.href=href;a.target='_blank';a.rel='noopener noreferrer';list.append(a);}
  refs.append(list);const bar=create('div','system-bar');bar.append(controls,refs);header.append(identity,title,bar);
  const structurePanel=create('main','system-structure-panel'),structureRoot=create('div','');structurePanel.append(structureRoot);
  const readingPanel=create('main','system-reading-panel'),context=create('div','system-mechanism-context'),readingRoot=create('div','');readingPanel.append(context,readingRoot);
  const modulePanel=create('main','system-module-panel'),atlasRoot=create('div','');modulePanel.append(atlasRoot);
  const moduleContext=create('nav','system-mechanism-context');moduleContext.append(create('span','','阅读所在：包架构「完整模块索引」'));
  const moduleBack=create('a','','返回包架构正文 ↗');moduleBack.href=documentationHref('完整模块索引',model,'packages');moduleContext.append(moduleBack);modulePanel.prepend(moduleContext);
  root.replaceChildren(header,structurePanel,readingPanel,modulePanel);
  let atlas=null,atlasHash='#view=modules&open=authority',structureHash='#view=structure';
  const selectHash=hash=>{if(location.hash!==hash)location.hash=hash;else show();};
  structureButton.addEventListener('click',()=>{if(pageView(location.hash)==='modules')atlasHash=location.hash;selectHash(structureHash);});
  moduleButton.addEventListener('click',()=>{if(pageView(location.hash)==='structure'&&location.hash)structureHash=location.hash;selectHash(atlasHash);});
  const explore=id=>{const p=new URLSearchParams({view:'modules'});if(id)p.set('node',id);else p.append('open','authority');selectHash('#'+p);};
  mountStructure(structureRoot,model,architecture,{onExplore:explore,documentationHref:anchor=>documentationHref(anchor,model)});
  mountSystemReading(readingRoot,model,{onExplore:explore});
  function show(){
    const view=pageView(location.hash);structurePanel.hidden=view!=='structure';readingPanel.hidden=view!=='reading';modulePanel.hidden=view!=='modules';
    structureButton.setAttribute('aria-pressed',String(view==='structure'));moduleButton.setAttribute('aria-pressed',String(view==='modules'));current.hidden=view!=='reading';
    if(view==='modules'){title.textContent='完整模块索引';atlasHash=location.hash;if(!atlas)atlas=mountArchitectureViewer(atlasRoot,model);requestAnimationFrame(()=>{if(!modulePanel.hidden&&atlas.state.focus)atlas.focusNode(atlas.state.focus,true);});}
    else if(view==='structure'){title.textContent='系统结构';if(location.hash)structureHash=location.hash;}
    else {const id=new URLSearchParams(location.hash.slice(1)).get('read');const selected=READING_MECHANISMS[id]||READING_MECHANISMS.loop;title.textContent=selected.kicker;current.textContent='机制参考';
      const section=id==='loop'?'3-沿一轮工作理解系统':id==='authority'?'4-为什么要有这些对象和权威边界':'5-变化和失败如何处理';
      context.replaceChildren(create('span','','此图用于架构总览 '+(id==='loop'?'§3 工作场景':id==='authority'?'§4 对象与权威':'§5 变化与失败')));
      const back=create('a','','返回对应正文 ↗');back.href=documentationHref(section,model);context.append(back);
    }
  }
  window.addEventListener('hashchange',show);show();
}
if(typeof document!=='undefined'){
  const root=document.getElementById('architecture-app'),data=document.getElementById('architecture-model'),structure=document.getElementById('architecture-structure');
  if(root&&data&&structure){try{mountSystemApp(root,JSON.parse(data.textContent),JSON.parse(structure.textContent));}catch(e){root.textContent=`架构图无法载入：${e.message}`;}}
}
