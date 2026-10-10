const labels={pending:'En attente',ready_to_ship:'Prêt à livrer',not_shipped:'Non expédié',shipped:'Expédié',in_transit:'En transit',delivered:'Livré',cancelled:'Annulé',exception:'Incident',unknown:'À vérifier',unpublished:'Brouillon'};
const status=value=>value?labels[value]||String(value):'Non vérifié';
const text=value=>String(value??'').slice(0,32767);
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():'';
const outcomes={updated:'BL Erplain mis à jour',proposed:'Mise à jour Erplain proposée',unchanged:'Statut inchangé',error:'À vérifier'};

export async function loadTrackingExport(db,{search='',runId=null}={}){
 search=String(search).slice(0,200);
 // One SQL statement: status, local order and history share the same database snapshot.
 const {rows}=await db.query(`WITH latest AS (
  SELECT DISTINCT ON (target_key) target_key,order_id,reference,result,created_at
  FROM tracking_sync_observations WHERE ($1::text IS NULL OR run_id=$1) ORDER BY target_key,id DESC
 ), selected AS (
  SELECT l.*,o.tracking_status AS v3_status,
   CASE WHEN l.result->>'partialId' IS NOT NULL AND p.bl->>'id'=l.result->>'blId' THEN p.bl->>'status'
    WHEN l.result->>'partialId' IS NULL AND o.erp_live->'bl'->>'id'=l.result->>'blId' THEN o.erp_live->'bl'->>'status' END AS v3_bl_status
  FROM latest l LEFT JOIN orders o ON o.id=l.order_id
  LEFT JOIN partial_deliveries p ON p.id=l.result->>'partialId' AND p.order_id=l.order_id
  WHERE l.reference ILIKE $2 OR l.result->>'blId' ILIKE $2 OR (l.result->'tracking')::text ILIKE $2
 ) SELECT statement_timestamp() AS generated_at,
  (SELECT coalesce(json_agg(s ORDER BY s.reference,s.target_key),'[]'::json) FROM selected s) AS rows,
  (SELECT coalesce(json_agg(c ORDER BY c.created_at,c.id),'[]'::json) FROM tracking_sync_changes c
   JOIN selected s ON s.target_key=c.target_key WHERE ($1::text IS NULL OR c.run_id=$1)) AS changes`,[runId,'%'+search+'%']);
 return {...rows[0],search,runId};
}

export async function trackingWorkbook(data,{Workbook}={}){
 if(!Workbook)({Workbook}= (await import('exceljs')).default);
 const book=new Workbook();book.creator='NEXTECH LOGISTIC V3';book.created=new Date(data.generated_at);
 function sheet(name,columns){
  const s=book.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
  s.columns=columns.map(([header,width])=>({header,width}));
  s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF294846'}};
  s.getRow(1).alignment={vertical:'middle',wrapText:true};s.getRow(1).height=42;
  s.autoFilter={from:{row:1,column:1},to:{row:1,column:columns.length}};
  return s;
 }
 function add(s,values){
  if(s.rowCount>=1048576)throw Error('Export trop volumineux pour Excel : préciser la recherche');
  // Plain text cells preserve leading zeroes and never become Excel formulas.
  const row=s.addRow(values.map(text));row.alignment={vertical:'top',wrapText:true};
  return row;
 }
 const statuses=sheet('Statuts',[
  ['Commande',28],['BL Erplain',18],['Livraison partielle',22],['Transporteur',16],['Numéros de suivi',32],
  ['Statut commande V3',24],['Statut BL dans V3',24],['Statut transporteur',24],['Statut Erplain connu',24],['Statut Erplain proposé',24],
  ['Contrôle transporteur / Erplain',30],['Dernière lecture transporteur (UTC)',28],['Dernière synchronisation (UTC)',28],['Résultat',34],['Erreurs',60]
 ]);
 const changes=sheet('Historique',[
  ['Commande',28],['BL Erplain',18],['Livraison partielle',22],['Date du changement observé (UTC)',28],
  ['Transporteur avant',24],['Transporteur après',24],['Erplain avant',24],['Erplain après',24]
 ]);
 const events=sheet('Événements',[
  ['Commande',28],['BL Erplain',18],['Livraison partielle',22],['Transporteur',16],['Numéro de suivi',28],['Date événement (UTC)',28],['Code transporteur',24],['Description',70]
 ]);
 const byKey=new Map();
 for(const item of data.rows){
  byKey.set(item.target_key,item);const r=item.result;
  const errors=[r.error,r.localError].filter(Boolean).join(' · ');
  const comparison=errors?'Erreur / à vérifier':!r.carrierStatus||r.carrierStatus==='unknown'||!r.lastKnownErplain?'Non vérifiable':r.carrierStatus===r.lastKnownErplain?'Concordant':['shipped','delivered'].includes(r.carrierStatus)?'Écart à vérifier':'À examiner';
  const row=add(statuses,[item.reference,r.blId,r.partialId,(r.carrier||'').toUpperCase(),(r.tracking||[]).join('\n'),status(item.v3_status),status(item.v3_bl_status),status(r.carrierStatus),status(r.lastKnownErplain),r.proposed?status(r.proposed):'',comparison,date(r.carrierObservedAt),date(item.created_at),outcomes[r.outcome]||r.outcome,errors]);
  row.getCell(11).fill={type:'pattern',pattern:'solid',fgColor:{argb:comparison==='Concordant'?'FFE1F3E7':'FFFFE9CB'}};
  const seen=new Set();
  for(const e of r.events||[]){
   const key=JSON.stringify([e.carrier,e.tracking,e.at,e.code,e.label]);if(seen.has(key))continue;seen.add(key);
   add(events,[item.reference,r.blId,r.partialId,(e.carrier||r.carrier||'').toUpperCase(),e.tracking,date(e.at),e.code,e.label]);
  }
 }
 for(const c of data.changes){
  const item=byKey.get(c.target_key);if(!item)continue;
  add(changes,[item.reference,item.result.blId,item.result.partialId,date(c.created_at),c.carrier_before?status(c.carrier_before):'Première lecture',status(c.carrier_after),c.erplain_before?status(c.erplain_before):'Première lecture',status(c.erplain_after)]);
 }
 const info=sheet('Informations',[['Information',38],['Valeur',100]]);
 for(const row of [
  ['Exporté le (UTC)',date(data.generated_at)],['Recherche appliquée',data.search||'Toutes les livraisons synchronisées'],['Synchronisation',data.runId||'Dernier résultat connu de chaque livraison'],['Nombre de livraisons',data.rows.length],
  ['Périmètre','Toutes les pages correspondant à la recherche dans la fenêtre de suivi. Les commandes jamais synchronisées ne figurent pas dans cet export.'],
  ['Fraîcheur','Les données proviennent des résultats enregistrés dans V3. Télécharger ce fichier ne relance pas les API et ne modifie aucun statut. Une synchronisation en cours peut donner un export partiel.'],
  ['Statuts V3','Les statuts de la commande et du BL dans V3 sont lus au moment de l’export. Un statut de commande ne décrit pas forcément un seul BL partiel.'],
  ['Statut Erplain connu','Dernier statut effectivement relu depuis Erplain. Une proposition de mise à jour est affichée dans une colonne distincte.'],
  ['Historique','Changements observés et enregistrés depuis la première synchronisation des livraisons exportées.'],
  ['Événements','Événements présents dans le dernier résultat enregistré de chaque livraison, éventuellement conservés d’une lecture précédente si la dernière tentative a échoué.'],
  ['Dates','Toutes les dates sont exprimées en UTC au format ISO 8601.']
 ])add(info,row);
 return Buffer.from(await book.xlsx.writeBuffer());
}
