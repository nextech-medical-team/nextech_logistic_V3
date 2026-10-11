// Transport observations describe the parcel only, never an ERP preparation gate.
export const preparationObservation='Suivi TEMU relu : seuls des événements de préparation sont observés. Aucun mouvement physique confirmé ; information de suivi sans effet sur les BC et BL.';
export const obsoletePreparationObservations=[
 'Absence de mouvement non vérifiable',
 'Suivi TEMU relu : seuls des événements de préparation sont observés. Reprise historique et autres contrôles à valider. Suspension conservée.',
 'Suivi TEMU relu : seuls des événements de préparation sont observés. Reprise historique et autres contrôles à valider.'
];
export function withoutPreparationObservation(raw){
 if(typeof raw!=='string')return raw;
 const parts=raw.split(';');
 if(!parts.some(p=>obsoletePreparationObservations.includes(p.trim())||p.trim()===preparationObservation))return raw;
 return parts.map(p=>p.trim()).filter(p=>p&&!obsoletePreparationObservations.includes(p)&&p!==preparationObservation).join('; ')||null;
}
export function withoutPreparationObservationSql(raw){
 const reasons=[...obsoletePreparationObservations,preparationObservation].map(s=>"'"+s.replaceAll("'","''")+"'").join(',');
 const parts=`regexp_split_to_table((${raw}),';') WITH ORDINALITY AS transport_reason(part,position)`;
 return `CASE WHEN (${raw}) LIKE '%Suivi TEMU relu%' OR (${raw}) LIKE '%Absence de mouvement non vérifiable%' THEN CASE WHEN EXISTS(SELECT 1 FROM ${parts} WHERE btrim(part) IN (${reasons})) THEN (SELECT string_agg(btrim(part),'; ' ORDER BY position) FROM ${parts} WHERE nullif(btrim(part),'') IS NOT NULL AND btrim(part) NOT IN (${reasons})) ELSE (${raw}) END ELSE (${raw}) END`;
}
export function currentMovementDetail(reason,detail){return reason==='preparation_only_observed'?preparationObservation:detail;}
