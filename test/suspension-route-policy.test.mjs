import test from 'node:test';import assert from 'node:assert/strict';import {suspensionGuardRequired} from '../src/suspension-route-policy.mjs';
test('suspended order remains consultable through the normal order table and progress reads',()=>{
 assert.equal(suspensionGuardRequired('/api/labels/batches','POST'),false);assert.equal(suspensionGuardRequired('/api/labels/create','POST'),true);assert.equal(suspensionGuardRequired('/api/labels/batches/other','POST'),true);assert.equal(suspensionGuardRequired('/api/orders','GET'),false);
 assert.equal(suspensionGuardRequired('/api/partial/visible','POST'),false);
 assert.equal(suspensionGuardRequired('/api/orders/processing','POST'),false);
});
test('a suspension still blocks document creation, stock writes, label purchases and mutations',()=>{
 for(const p of ['/api/resolutions','/api/partial/create','/api/carriers/create','/api/temu/labels/buy','/api/orders/erp','/api/erplain/live/create','/api/import-corrections/apply'])assert.equal(suspensionGuardRequired(p,'POST'),true);
});

