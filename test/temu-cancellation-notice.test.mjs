import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {platformIndicativeView} from '../src/platform-indicative-view.mjs';
const order=()=>({channel:'temu',reference:'PO-TEST',erp_live:{bc:{id:12,label:'C-TEST',status:'active'}},source_payload:{temuDirect:{status:2,verifiedAt:'2026-11-06T10:00:00Z'},platformCancellationObservation:{source:'temu_direct',reference:'PO-TEST',status:3,observedAt:'2026-11-06T11:00:00Z'}}});
test('confirmed cancellation observation produces a dated notice without changing business state',()=>{
 const o=order(),before=structuredClone(o),v=platformIndicativeView(o);
 assert.equal(v.cancelled,true);assert.equal(v.status,'3');assert.equal(v.observedAt,'2026-11-06T11:00:00Z');assert.match(v.cancellationNotice.message,/BC C-TEST : annulation Erplain à vérifier/);assert.deepEqual(o,before);
});
test('newer source receipt retires the cancellation notice even with an older direct status',()=>{
 const o=order();o.source_payload.temuDirect.status=3;
 o.source_payload.platformStatusObservation={observedAt:'2026-11-06T12:00:00Z',payload:{detail:{parentOrderMap:{parentOrderStatus:2}}}};
 const v=platformIndicativeView(o);assert.equal(v.status,'2');assert.equal(v.cancelled,false);assert.equal(v.cancellationNotice,undefined);
});
test('unmatched or undated cancellation observations cannot raise a notice',()=>{
 for(const patch of [{reference:'OTHER'},{observedAt:'invalid'}]){const o=order();Object.assign(o.source_payload.platformCancellationObservation,patch);assert.equal(platformIndicativeView(o).cancellationNotice,undefined);}
});
test('notice distinguishes missing and cancelled BCs without asserting shipment cancellation',()=>{
 const o=order();delete o.erp_live;assert.match(platformIndicativeView(o).cancellationNotice.message,/Aucun BC/);
 o.erp_live={bc:{id:12,status:'cancelled'}};assert.match(platformIndicativeView(o).cancellationNotice.message,/BC 12 annulé dans Erplain/);
});
test('order renderer displays and escapes cancellation notice without action controls',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('function platformStatusHtml(o){'),source.indexOf('\nfunction erplainTrackingHtml'));
 const ctx=vm.createContext({esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')});vm.runInContext(fn,ctx);
 const o=order();o.erp_live.bc.label='<img src=x onerror=alert(1)>';
 const html=ctx.platformStatusHtml({platform_status:platformIndicativeView(o)});
 assert.match(html,/data-temu-cancellation-notice role="status"/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<button/);
 assert.doesNotMatch(ctx.platformStatusHtml({platform_status:{channel:'temu',status:'2',cancelled:false}}),/data-temu-cancellation-notice/);
});
