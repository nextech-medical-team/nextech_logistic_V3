import test from 'node:test';
import assert from 'node:assert/strict';
import {retiredLabelPreparationReview} from '../src/post-bl-preparation-review.mjs';
import {retiredPostBlLabelReasons} from '../src/post-bl-label-history.mjs';

test('only known retired business observations are superseded after BL',()=>{
 for(const reason of [...retiredPostBlLabelReasons,'BC · Quantités réservées non confirmées','BC · Quantités réservées non confirmées · SKU A : commandées 10, réservées 0','BL bloqué — stock insuffisant : A : manque 1'])assert.equal(retiredLabelPreparationReview(reason),true,reason);
 for(const reason of [null,undefined,'','Annulation à vérifier','GLS HTTP 400','Résultat incertain','Commande suspendue','BC · Quantités réservées non confirmées ; annulation incertaine','Autre correction requise'])assert.equal(retiredLabelPreparationReview(reason),false,reason);
});
