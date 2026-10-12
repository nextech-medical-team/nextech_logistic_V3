// Only a replacement already certified deployed may retire pending predecessors.
// An actively deploying predecessor is retained even if the file is inconsistent.
export function obsoletePendingRequest(doc,certifiedIds){
 return ['ready','blocked','failed'].includes(doc.status)&&certifiedIds.has(doc.id);
}
