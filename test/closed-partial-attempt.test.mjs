import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/partial.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const partialStatuses='),source.indexOf('Object.assign(labels,')),context);
const closed={status:'cancelled',stage:'cancelled',bl:null,documents:0,tracking:[],error:'Tentative locale non créée clôturée après rapprochement du stock ; quantités à sélectionner de nouveau.'};
test('released local preparation has no cancelled BL claim',()=>{
 assert.equal(context.isClosedPartialAttempt(closed),true);
 assert.equal(context.partialStatusText(closed),'Préparation clôturée — aucun BL créé');
 assert.equal(context.partialBlText(closed),'Aucun BL créé');
});
test('actual BL cancellations and uncertain history retain cancellation display',()=>{
 for(const changes of [{bl:{id:'123'}},{bl:{label:'SHO123'}},{documents:1},{documents:undefined},{tracking:['TRACK']},{tracking:undefined},{error:'BL annulé par opérateur'},{stage:'creating_bl'}]){
  const delivery={...closed,...changes};assert.ok(!context.isClosedPartialAttempt(delivery));
  assert.equal(context.partialStatusText(delivery),'BL annulé — ancienne étiquette conservée');
 }
 assert.equal(context.partialStatusText({...closed,status:'review'}),'À vérifier');
});
