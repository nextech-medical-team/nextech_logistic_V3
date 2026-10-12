import {completeOrderDocumentsSql} from '../src/complete-order-documents.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {resolveReplacementLines} from '../src/resolution-quantities.mjs';

const source=readFileSync(new URL('../src/problem-resolution.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function context('),source.indexOf('export function resolutionService'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const executeContext=new AsyncFunction('completeOrderDocumentsSql','db','id','projectCurrentDiagnostics','attachEquivalentDiagnostics','projectSharedParcelContext','correctionCatalog','pricingFingerprint','resolveReplacementLines',body+';return context(db,"isolated",id);');
const execute=(...args)=>executeContext(completeOrderDocumentsSql,...args,resolveReplacementLines);
function order(){return {id:'order',channel:'temu',issue:'TEMU · Prix client et TVA source incohérents',resolution_pending_resume:true,erp_live:{phase:'historical_review',bc:{id:123},pricing:{status:'verified',confirmed:{total:12,sourceTotal:12,authority:'erplain'},commercialBasis:{field:'estimatedRevenue',sourceEstimatedRevenue:{amount:12,currency:'EUR'}}}},source_payload:{temuAmounts:{data:{parentOrderMap:{estimatedRevenue:{amount:12,currency:'EUR'}}}}}};}
async function context(o){const writes=[];const db={query:async sql=>{writes.push(sql);if(sql.startsWith('SELECT orders.*, '))return {rows:[structuredClone(o)]};if(sql==='SELECT status,error FROM erp_live_jobs WHERE order_id=$1')return {rows:[{status:'review',error:o.issue}]};return {rows:[]};}};const result=await execute(db,o.id,projectCurrentDiagnostics,async()=>{},x=>x,async()=>[],()=>null);assert.ok(writes.every(s=>s.startsWith('SELECT')));return result;}
test('resolution context and listing agree on historical BL rather than verified old pricing',async()=>{const o=order(),before=JSON.stringify(o),ctx=await context(o);assert.equal(ctx.order.issue,'Reprise historique à vérifier : BL non créé');assert.equal(ctx.erpJob.error,ctx.order.issue);assert.equal(JSON.stringify(o),before);const problems=currentProblemClassifier()({...ctx.order,erp_live_job:ctx.erpJob});assert.equal(problems.length,1);assert.equal(problems[0].type,'historical-preparation');});
test('changed marketplace amounts cannot restore a finance veto after recorded BC confirmation',async()=>{const o=order();o.source_payload.temuAmounts.data.parentOrderMap.estimatedRevenue.amount=13;const ctx=await context(o);assert.equal(ctx.order.issue,'Reprise historique à vérifier : BL non créé');assert.equal(ctx.erpJob.error,ctx.order.issue);});
test('missing confirmed BC proof does not silently certify the historical preparation',async()=>{const o=order();o.erp_live.pricing.status='review';const ctx=await context(o);assert.equal(ctx.order.issue,o.issue);assert.equal(ctx.erpJob.error,o.issue);});
test('historical problem permits only document comparison and guarded ERP resume',()=>{const literal=source.slice(source.indexOf('const actionTypes=')+'const actionTypes='.length,source.indexOf('\n};',source.indexOf('const actionTypes='))+2);const types=new Function('productTypes','return '+literal)(['mapping','missing','duplicate','inactive','weight','weight-unit']);assert.ok(types['resume-erp'].includes('historical-preparation'));assert.ok(types['compare-bc'].includes('historical-preparation'));for(const [action,allowed]of Object.entries(types))if(!['resume-erp','compare-bc'].includes(action))assert.ok(!allowed.includes('historical-preparation'),action);});

test('document proof removes dialog blockers while preserving raw historical job status and writes',async()=>{
 const o=order();o.complete_order_documents=true;const before=JSON.stringify(o),ctx=await context(o);
 assert.equal(ctx.order.complete_order_documents,true);
 assert.equal(currentProblemClassifier()({...ctx.order,erp_live_job:ctx.erpJob}).length,0);
 assert.equal(ctx.erpJob.status,'review');assert.equal(JSON.stringify(o),before);
});
