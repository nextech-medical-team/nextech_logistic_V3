const timestamp=value=>value instanceof Date?value.getTime():Date.parse(value||'');
// Seen and accepted versions differ while a commercial reconciliation is pending.
// No platform declaration participates in this decision.
export function platformReceiptDisposition({observedVersion,incomingVersion,pending=false}){
 const observed=timestamp(observedVersion),incoming=timestamp(incomingVersion);
 if(observedVersion!=null&&!Number.isFinite(observed))throw Error('Date de version reçue non vérifiable');
 if(!Number.isFinite(incoming)){
  if(observedVersion!=null||pending)throw Error('Date de modification source absente ou invalide : dernière version conservée');
  return 'process';
 }
 if(Number.isFinite(observed)&&(incoming<observed||incoming===observed&&!pending))return 'skip';
 return 'process';
}
