import {preparationCadence} from './preparation-observation.mjs';

// Only expose a proof for the same requested source version and within its TTL.
// This changes the displayed observation, never a preparation/job/business state.
export function currentPreparationObservation(state,version,now=Date.now()){
 const observation=state?.preparationObservation;
 const readAt=Date.parse(observation?.observedAt),expires=Date.parse(observation?.expiresAt);
 return version!=null&&state?.preparationObservedVersion!=null&&observation?.schemaVersion===1&&String(state.preparationObservedVersion)===String(version)&&Number.isFinite(readAt)&&now>=readAt&&now-readAt<preparationCadence.external&&Number.isFinite(expires)&&expires>now?observation:null;
}
export function preparationMonitorView(state,version,now=Date.now()){
 const observation=currentPreparationObservation(state,version,now);if(!observation)return state;
 const messages=[...observation.business,...observation.technical].map(d=>d.message);
 const result=messages.join(' ; ')||observation.nextStep||'Préparation en attente de vérification';
 const progressAt=Date.parse(state.lastProgress),alert=observation.blocked&&Number.isFinite(progressAt)&&now-progressAt>=preparationCadence.alert;
 const nextStep=observation.business.length?'Corriger le motif métier indiqué puis recontrôler la préparation':observation.technical.length?'Rétablir ou rapprocher la lecture Erplain avant toute reprise':observation.nextStep;
 return {...state,result,nextStep,blocked:observation.blocked,lastCheck:observation.observedAt,alert,preparationObservationCurrent:true,preparationObservation:observation,businessDiagnostics:observation.business,technicalDiagnostics:observation.technical,preparationProcessing:observation.processing};
}
export function projectPreparationActivity(row){
 const observation=row.monitoring?.preparationObservation;
 if(!observation||row.monitoring?.preparationObservationCurrent!==true)return row;
 const obsolete=reason=>!reason||observation.mappingVerified===true&&/^BC · Mapping manquant : /.test(reason);
 const project=activity=>activity.service==='Erplain'&&activity.state==='blocked'&&obsolete(activity.reason)?{...activity,reason:row.monitoring.result}:activity;
 const out=project(row);return {...out,activities:(out.activities||[]).map(project)};
}
