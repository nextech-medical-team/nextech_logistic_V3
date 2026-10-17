import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceProductName,minimalProductInput} from '../src/missing-product-creation.mjs';
test('TEMU nested Excel French title supplies the real catalogue name without SKU, price or quantity changes',()=>{
 const payload={origin:'temu_excel',excel:{'nom du produit':'10x10 – PHARMAPLAST – Boîte de 10 pièces','contribution SKU':'JN100100','quantité achetée':'2','prix de base des marchandises':'5,90€'}};
 const original=structuredClone(payload),name=sourceProductName({source_payload:payload});assert.equal(name,payload.excel['nom du produit']);
 assert.deepEqual(minimalProductInput('JN100100',name),{label:name,active:true,variants:{data:[{type:'normal',sku:'JN100100',track_inventory:true,weight_amount:5,weight_unit:'g'}]}});assert.deepEqual(payload,original);
});
test('existing direct source title keeps priority; normalized French headers and customer product title are supported',()=>{
 assert.equal(sourceProductName({source_payload:{productName:'Authoritative source',excel:{'nom du produit':'Other'}}}),'Authoritative source');
 assert.equal(sourceProductName({source_payload:{excel:{' NOM DU PRODUIT ':'  Produit\nréel  '}}}),'Produit réel');
 assert.equal(sourceProductName({source_payload:{excel:{'nom du produit par commande du client':'Libellé enregistré'}}}),'Libellé enregistré');
});
test('absent, non-string and unrelated values never invent a product title',()=>{
 for(const source_payload of [null,{}, {excel:[]},{excel:{'nom du produit':{},'contribution SKU':'481007'}},{excel:{'nom du destinataire':'Client','nom du produit':'  '}}])assert.equal(sourceProductName({source_payload}),'');
 assert.throws(()=>minimalProductInput('481007',sourceProductName({source_payload:{excel:{}}})),/Nom du produit manquant/);
});
