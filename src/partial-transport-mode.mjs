import {suspensionBlock} from './order-suspension.mjs';
export const temuBlOnly='bl_only_temu';
export function partialPreparationChoice(order,choice){
 if(!order)throw Error('Commande introuvable');
 if(order.channel==='temu'){
  if(choice!==temuBlOnly)throw Error('TEMU · Choisir « Créer uniquement le BL partiel » : aucun achat ni changement d’étiquette');
  return choice;
 }
 if(choice===temuBlOnly)throw Error('Mode BL seul réservé au circuit TEMU');
 if(choice==='reuse')throw Error('Chaque nouveau BL nécessite une nouvelle étiquette');
 if(choice!=null&&choice!=='new')throw Error('Choix de transport partiel invalide');
 return 'new';
}
export function assertPartialTransportMode(order,delivery){
 if(!order)throw Error('Commande introuvable');
 if(order.channel!=='temu'){if(delivery.label_choice===temuBlOnly)throw Error('Circuit modifié : aucun repli transporteur autorisé');return false;}
 if(delivery.label_choice!==temuBlOnly)throw Error('TEMU · BL partiel seul requis, création transporteur interdite');
 if(suspensionBlock(order)||order.archived||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))throw Error('Commande suspendue, annulée ou déjà expédiée');
 return true;
}
