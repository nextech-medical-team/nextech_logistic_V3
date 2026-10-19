import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveredPreparationIssue} from '../src/recovered-preparation-issue.mjs';
import {synchronizeRecoveredOrder} from '../src/erplain-targeted-orders.mjs';

test('a chosen GOFO delivery no longer asks the operator to choose its circuit again',()=>{
 const order={transport_choice:'gofo',resolution_pending_resume:true};
 const state={bl:{id:1911773,status:'ready_to_ship'}};
 const before=JSON.stringify({order,state});
 assert.equal(recoveredPreparationIssue(order,state),'BL Erplain prêt à livrer : vérifier puis créer l’étiquette GOFO manuellement');
 assert.equal(JSON.stringify({order,state}),before);
});
test('a displayed routing default does not stand in for an explicit carrier choice',()=>{
 assert.equal(recoveredPreparationIssue({carrier:'gofo'},{bl:{id:1,status:'ready_to_ship'}}),'Commande Erplain validée : choisir le circuit de préparation');
});
test('unknown or unverified delivery keeps the circuit decision',()=>{
 for(const status of ['pending','in_preparation','shipped','delivered',null])
  assert.equal(recoveredPreparationIssue({transport_choice:'gofo'},{bl:{id:1,status}}),'Commande Erplain validée : choisir le circuit de préparation');
 assert.equal(recoveredPreparationIssue({transport_choice:'gofo'},{bl:{status:'ready_to_ship'}}),'Commande Erplain validée : choisir le circuit de préparation');
 assert.equal(recoveredPreparationIssue({transport_choice:'unknown'},{bl:{id:1,status:'ready_to_ship'}}),'Commande Erplain validée : choisir le circuit de préparation');
});
test('GLS service choices retain the specific selected circuit',()=>{
 for(const [choice,name] of [['gls','GLS'],['gls_pharma','GLS Pharma'],['gls_shop','GLS relais']])
  assert.equal(recoveredPreparationIssue({transport_choice:choice},{bl:{id:1,status:'ready_to_ship'}}),`BL Erplain prêt à livrer : vérifier puis créer l’étiquette ${name} manuellement`);
});

test('rereading an existing ready BL persists the next step and retains the hold without queueing transport',async()=>{
 const variant={id:7,sku:'TEST',active:true,track_inventory:true,weight_amount:1,weight_unit:'g',product:{active:true}};
 const line={id:11,type:'normal',quantity:2,shipped_quantity:0,price:10,tax_amount:4,available:20,on_hand:20,reserved_quantity:0,location:{id:3},variant};
 const bl={id:13,label:'BL-13',status:'ready_to_ship',line_items:[{parent_id:11,quantity:2,variant}]};
 const document={id:5,label:'BC-5',status:'active',update_stock:true,total:24,currency:{label:'EUR'},customer:{id:9,label:'Test'},shipping_address:{label:'Test',address_1:'1 rue Test',postal_code:'75001',city:'Paris',country:'FR',phone:'0612345678'},line_items:[line],shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}};
 const order={id:'order',transport_choice:'gofo',source_payload:{erplainImported:true,account:'live'},erp_live:{bc:document,bl,pendingBlIds:[13],verifiedAt:'old',stockCheckedAt:'old'},address:{},archived:false,partial_mode:false};
 const local=[{id:'local',source_line:'11',source_payload:{erplainVariantId:'7'},target_sku:'TEST',target_quantity:2}];
 const writes=[];
 const db={query:async(q,p)=>{if(q==='SELECT * FROM lines WHERE order_id=$1')return {rows:local};if(q.startsWith('UPDATE')||q.startsWith('INSERT')||q.startsWith('DELETE'))writes.push({q,p});return {rows:[]};}};
 await synchronizeRecoveredOrder(db,order,document);
 const update=writes.find(x=>x.q.includes('issue=$3'));
 assert.equal(update.p[2],'BL Erplain prêt à livrer : vérifier puis créer l’étiquette GOFO manuellement');
 assert.match(update.q,/resolution_pending_resume=true/);
 const persisted=JSON.parse(update.p[1]);
 assert.equal(persisted.bl.id,13);assert.equal(persisted.bl.status,'ready_to_ship');
 assert.equal(persisted.verifiedAt,undefined);assert.equal(persisted.stockCheckedAt,undefined);
 assert.ok(!writes.some(x=>/carrier_jobs|carrier_documents|resolution_jobs/.test(x.q)));
});
