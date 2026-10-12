import test from 'node:test';import assert from 'node:assert/strict';
import {obsoletePendingRequest} from './queue-replacements.mjs';
for(const status of ['ready','blocked','failed'])test('certified replacement retires '+status,()=>assert.equal(obsoletePendingRequest({id:'old',status},new Set(['old'])),true));
for(const status of ['ready','blocked','failed','deploying'])test('uncertified '+status+' remains',()=>assert.equal(obsoletePendingRequest({id:'old',status},new Set()),false));
test('active publication remains despite contradictory replacement',()=>assert.equal(obsoletePendingRequest({id:'old',status:'deploying'},new Set(['old'])),false));
test('unrelated request remains',()=>assert.equal(obsoletePendingRequest({id:'other',status:'ready'},new Set(['old'])),false));
