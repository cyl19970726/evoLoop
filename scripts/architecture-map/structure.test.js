import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { structureDiagram, STRUCTURE_ALIASES, parseStructureState } from './structure.js';
import { renderPlainSvg, wrapDiagramText } from './plain-svg.js';
const architecture=JSON.parse(fs.readFileSync(new URL('../../docs/assets/evoloop-system-structure.architecture.json',import.meta.url),'utf8'));
const model=JSON.parse(fs.readFileSync(new URL('../../docs/assets/evoloop-system.model.json',import.meta.url),'utf8'));

test('collapsed process keeps every cross-boundary relationship and its direction',()=>{
  const diagram=structureDiagram(architecture);
  const internal=new Set(architecture.boundaries[0].wraps);
  const project=id=>internal.has(id)?'coordinator':id;
  const expected=architecture.connections
    .map(edge=>[edge.id,project(edge.from),project(edge.to)])
    .filter(([,from,to])=>from!==to);
  assert.deepEqual(diagram.edges.map(edge=>[edge.id,edge.from,edge.to]),expected);
  assert.ok(diagram.nodes.some(node=>node.id==='coordinator'));
  assert.ok(!diagram.nodes.some(node=>internal.has(node.id)));
});

test('structure preserves the sourced topology and keeps external authority outside the coordinator',()=>{
  const diagram=structureDiagram(architecture,{expanded:true});
  assert.deepEqual(diagram.edges.map(e=>[e.id,e.from,e.to]),architecture.connections.map(e=>[e.id,e.from,e.to]));
  const group=diagram.groups[0];
  for(const id of ['postgres','wiki-service','git-repos','codex','feishu','actors','entry']){
    const n=diagram.nodes.find(n=>n.id===id);
    assert.ok(n.x+n.w<=group.x||n.x>=group.x+group.w||n.y+n.h<=group.y||n.y>=group.y+group.h,id);
  }
  for(const id of ['core-to-ports','adapters-to-ports'])assert.equal(diagram.edges.find(e=>e.id===id).kind,'reference');
  assert.ok(!diagram.edges.some(e=>e.from==='feishu'&&e.to==='postgres'));
  assert.ok(diagram.edges.find(e=>e.from==='adapters'&&e.to==='api').label.includes('基线'));
  for(const n of diagram.nodes)assert.ok(model.nodes.some(m=>m.id===(STRUCTURE_ALIASES[n.id]||n.id)),n.id);
});

test('structural scope links preserve nested disclosure while complete-index links remain separate',()=>{
  const state=parseStructureState(model,'#view=structure&scope=core&expand=knowledge&expand=knowledge-ports');
  assert.equal(state.scope,'core');assert.deepEqual([...state.expanded],['knowledge','knowledge-ports']);
  assert.equal(parseStructureState(model,'#scope=missing').scope,null);
  const packages=model.nodes.filter(n=>n.path&&/^(packages|apps)\//.test(n.path)&&!n.path.endsWith('/'));
  const groups=['entry','coordinator','core','contracts','adapters','support'];
  for(const n of packages){let parent=n;while(parent&&!groups.includes(parent.id))parent=model.nodes.find(m=>m.id===parent.parent);assert.ok(parent,n.path);}
});

test('plain SVG safely escapes content and keeps Latin labels intact when wrapping',()=>{
  assert.deepEqual(wrapDiagramText('人类与领域 Session',14),['人类与领域','Session']);
  const svg=renderPlainSvg({title:'<example>',width:200,height:100,nodes:[{id:'one',x:5,y:5,w:190,h:90,label:'<script>',lines:['A & B']}],edges:[]});
  assert.ok(svg.includes('&lt;script&gt;'));assert.ok(!svg.includes('<script>'));
  assert.throws(()=>renderPlainSvg({width:100,height:100,nodes:[],edges:[{id:'bad',from:'a',to:'b'}]}),/endpoint/);
});
