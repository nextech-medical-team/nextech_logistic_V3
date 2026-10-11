import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function platformStatusHtml(o){'),source.indexOf('\nfunction erplainTrackingHtml'));
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const context=vm.createContext({esc});vm.runInContext(fn,context);
const render=status=>context.platformStatusHtml({platform_status:{channel:'temu',status,cancelled:Number(status)===3,observedAt:'2026-10-11T08:00:00Z'}});
test('all documented TEMU codes have concise labels beneath retained code',()=>{
 for(const [code,label] of Object.entries({1:'En attente',2:'À expédier',3:'Annulée',4:'Expédiée',5:'Reçue',41:'Partiellement expédiée',51:'Partiellement reçue'})){
  for(const value of [code,Number(code)]){const html=render(value);assert.ok(html.includes('Code '+code+'<br><span data-temu-status-label>'+label+'</span>'));assert.ok(html.includes('Lu le '));assert.equal((html.match(/Annulée/g)||[]).length,code==='3'?1:0);}
 }
});
test('missing, unknown and untrusted codes have explicit safe displays',()=>{
 for(const value of [null,undefined,''])assert.ok(render(value).includes('Statut TEMU indisponible'));
 for(const value of [0,99,'99'])assert.ok(render(value).includes('Statut non reconnu'));
 assert.ok(render('<script>').includes('Code &lt;script&gt;'));assert.ok(!render('<script>').includes('<script>'));
});
test('indicative policy, dates, last-observation errors and other channels remain intact',()=>{
 const html=context.platformStatusHtml({platform_status:{channel:'temu',status:4,error:'timeout'}});
 assert.ok(html.includes('sans effet sur la préparation'));assert.ok(html.includes('évolution physique du colis'));assert.ok(html.includes('dernière observation conservée'));
 assert.ok(context.platformStatusHtml({platform_status:{channel:'shopify',status:'fulfilled'}}).includes('Expédiée'));
 assert.ok(context.platformStatusHtml({platform_status:{channel:'amazon',status:'Shipped'}}).includes('Shipped'));
});
