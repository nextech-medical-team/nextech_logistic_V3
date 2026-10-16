import {readFileSync,statSync} from 'node:fs';
import vm from 'node:vm';
// Compile the served classifier, so filter names cannot drift from the badges.
const source=new URL('../public/compact-problems.js',import.meta.url);
let revision='',classifier,deliveryPredicate;
export function currentProblemClassifier(){
 const stat=statSync(source),key=stat.mtimeMs+':'+stat.size;
 if(key!==revision){const context=vm.createContext({});vm.runInContext(readFileSync(source,'utf8'),context,{timeout:1000});classifier=context.compactProblems;deliveryPredicate=context.isDeliveredOrder;if(typeof classifier!=='function'||typeof deliveryPredicate!=='function')throw Error('Classificateur de problèmes indisponible');revision=key;}
 return classifier;
}
export function isDeliveredOrder(order){currentProblemClassifier();return deliveryPredicate(order);}
