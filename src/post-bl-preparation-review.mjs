import {retiredPostBlLabelReasons} from './post-bl-label-history.mjs';

// Historical business observations cannot veto a label after a published BL.
// Unknown reviews, cancellations and provider outcomes remain protected.
export function retiredLabelPreparationReview(reason){
 return typeof reason==='string'&&(retiredPostBlLabelReasons.includes(reason)
  ||/^BC · Quantités réservées non confirmées(?:$| · SKU )/.test(reason)
  ||/^BL bloqué — stock insuffisant : /.test(reason));
}
