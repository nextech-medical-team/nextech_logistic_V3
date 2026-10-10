import {createHash} from 'node:crypto';
import {open,rename,unlink,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
const ident=s=>'"'+String(s).replaceAll('"','""')+'"';
const table=s=>'public.'+ident(s);
const digest=rows=>createHash('sha256').update(rows.sort().join('\n')).digest('hex');
const rowHash=row=>createHash('sha256').update(JSON.stringify(row)).digest('hex');
export async function transferSchema(db){
 const tables=(await db.query("SELECT tablename name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
 for(const t of tables){t.columns=(await db.query("SELECT a.attname name,format_type(a.atttypid,a.atttypmod) type,a.attgenerated generated,a.attidentity identity FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",[t.name])).rows;}
 return tables;
}
async function format(db){await db.exec("SET TIME ZONE 'UTC'; SET DateStyle TO ISO; SET extra_float_digits TO 3; SET bytea_output TO hex;");}
async function* rows(db,t){
 let cursor=null,alias='__transfer_cursor';while(t.columns.some(c=>c.name===alias))alias+='x';
 for(;;){const batch=(await db.query(`SELECT ctid::text AS ${ident(alias)},${t.columns.map(c=>`${ident(c.name)}::text AS ${ident(c.name)}`).join(',')} FROM ${table(t.name)} ${cursor?'WHERE ctid>$1::tid':''} ORDER BY ctid LIMIT 100`,cursor?[cursor]:[])).rows;if(!batch.length)return;
  for(const row of batch)yield t.columns.map(c=>row[c.name]);cursor=batch.at(-1)[alias];
 }
}
export async function exportDatabase(db,destination){
 try{await stat(destination);throw Error('Destination déjà existante : export refusé');}catch(e){if(e.code!=='ENOENT')throw e;}
 const temporary=destination+'.incomplete',file=await open(temporary,'wx',0o600);let closed=false;
 try{const manifest=await db.transaction(async tx=>{
  await tx.exec('SET TRANSACTION READ ONLY');await format(tx);const schema=(await transferSchema(tx)).filter(t=>!['schema_migrations','sessions','worker_health'].includes(t.name)),summaries=[];
  const write=record=>file.writeFile(JSON.stringify(record)+'\n');await write({format:'nextech-database-transfer',version:1,schema});
  for(const t of schema){const hashes=[];for await(const row of rows(tx,t)){await write({table:t.name,row});hashes.push(rowHash(row));}summaries.push({name:t.name,count:hashes.length,sha256:digest(hashes)});}
  const result={tables:summaries};await write({complete:result});return result;
 });await file.sync();await file.close();closed=true;await rename(temporary,destination);return manifest;
 }catch(e){if(!closed)await file.close();await unlink(temporary).catch(()=>{});throw e;}
}
async function* records(filename){const input=createReadStream(filename),lines=createInterface({input,crlfDelay:Infinity});try{for await(const line of lines){if(!line.trim())throw Error('Archive invalide');yield JSON.parse(line);}}finally{lines.close();input.destroy();}}
export async function inspectArchive(filename){
 let header,complete;const hashes=new Map();
 for await(const record of records(filename)){
  if(!header){if(record.format!=='nextech-database-transfer'||record.version!==1||!Array.isArray(record.schema))throw Error('Format de migration non reconnu');header=record;
   for(const t of header.schema){if(!t.name||hashes.has(t.name)||!Array.isArray(t.columns)||!t.columns.length||new Set(t.columns.map(c=>c.name)).size!==t.columns.length)throw Error('Schéma de migration invalide');hashes.set(t.name,[]);}continue;}
  if(complete)throw Error('Données présentes après la fin de l’archive');
  if(record.complete){complete=record.complete;continue;}
  const t=header.schema.find(t=>t.name===record.table);if(!t||!Array.isArray(record.row)||record.row.length!==t.columns.length||record.row.some(v=>v!==null&&typeof v!=='string'))throw Error('Ligne de migration invalide');hashes.get(t.name).push(rowHash(record.row));
 }
 if(!header||!complete||!Array.isArray(complete.tables)||complete.tables.length!==header.schema.length||new Set(complete.tables.map(t=>t.name)).size!==header.schema.length)throw Error('Archive incomplète');
 for(const t of complete.tables){const values=hashes.get(t.name);if(!values||values.length!==t.count||digest(values)!==t.sha256)throw Error('Archive altérée : '+t.name);}
 return {schema:header.schema,manifest:complete};
}
export function dependencyOrder(names,edges){
 const pending=new Set(names),ordered=[];
 while(pending.size){const ready=[...pending].filter(n=>!edges.some(e=>e.child===n&&pending.has(e.parent))).sort();if(!ready.length)throw Error('Relations circulaires : migration à adapter avant toute écriture');for(const n of ready){pending.delete(n);ordered.push(n);}}
 return ordered;
}
export async function restoreDatabase(db,filename){
 const archive=await inspectArchive(filename);
 return db.transaction(async tx=>{
  await format(tx);await tx.exec("SET LOCAL lock_timeout='5s'");const target=await transferSchema(tx);
  const targetNames=new Set(target.map(t=>t.name));
  for(const source of archive.schema){const dest=target.find(t=>t.name===source.name);if(!dest)throw Error('Table cible absente : '+source.name);for(const c of source.columns){const d=dest.columns.find(d=>d.name===c.name);if(!d||d.type!==c.type||d.generated!==c.generated||d.identity!==c.identity)throw Error('Schéma cible incompatible : '+source.name+'.'+c.name);}}
  // An exclusive lock closes the gap between emptiness checks and insertion.
  if(target.length)await tx.exec(`LOCK TABLE ${target.map(t=>table(t.name)).join(',')} IN ACCESS EXCLUSIVE MODE`);
  for(const t of target)if(t.name!=='schema_migrations'&&(await tx.query(`SELECT EXISTS(SELECT 1 FROM ${table(t.name)}) AS occupied`)).rows[0].occupied)throw Error('Base cible non vide : aucune donnée ne sera remplacée');
  const edges=(await tx.query("SELECT c.relname child,p.relname parent FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE f.contype='f' AND n.nspname='public'")).rows;
  if(edges.some(e=>!targetNames.has(e.parent)))throw Error('Relation vers une autre base de données : migration refusée');
  const ordered=dependencyOrder(archive.schema.map(t=>t.name),edges);
  const triggers=(await tx.query("SELECT c.relname tablename,t.tgname name,t.tgenabled enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")).rows;
  for(const trigger of triggers)if(trigger.enabled!=='D')await tx.exec(`ALTER TABLE ${table(trigger.tablename)} DISABLE TRIGGER ${ident(trigger.name)}`);
  for(const name of ordered){const t=archive.schema.find(t=>t.name===name),input=t.columns.map((c,i)=>({...c,i})).filter(c=>!c.generated),hashes=[];
   // Streaming by table trades file rereads for bounded memory and preserves FKs.
   for await(const record of records(filename)){if(record.table!==name)continue;await tx.query(`INSERT INTO ${table(name)}(${input.map(c=>ident(c.name)).join(',')}) OVERRIDING SYSTEM VALUE VALUES(${input.map((c,i)=>'$'+(i+1)+'::text::'+c.type).join(',')})`,input.map(c=>record.row[c.i]));}
   for await(const row of rows(tx,t))hashes.push(rowHash(row));const expected=archive.manifest.tables.find(t=>t.name===name);if(hashes.length!==expected.count||digest(hashes)!==expected.sha256)throw Error('Relecture de migration différente : '+name);
  }
  for(const t of target)for(const c of t.columns){const seq=(await tx.query('SELECT pg_get_serial_sequence($1,$2) name',[table(t.name),c.name])).rows[0].name;if(!seq)continue;const config=(await tx.query('SELECT seqincrement::text step,seqmin::text minimum FROM pg_sequence WHERE seqrelid=$1::regclass',[seq])).rows[0];if(config.step!=='1')throw Error('Séquence non prise en charge : '+t.name);const maximum=(await tx.query(`SELECT max(${ident(c.name)})::text value FROM ${table(t.name)}`)).rows[0].value;const next=maximum===null?BigInt(config.minimum):BigInt(maximum)+1n;
   const pieces=seq.split('.').map(p=>p.replace(/^"|"$/g,'').replaceAll('""','"'));if(pieces.length!==2)throw Error('Nom de séquence non pris en charge');await tx.exec(`ALTER SEQUENCE ${pieces.map(ident).join('.')} RESTART WITH ${next}`);
  }
  for(const trigger of triggers)if(trigger.enabled!=='D')await tx.exec(`ALTER TABLE ${table(trigger.tablename)} ${trigger.enabled==='A'?'ENABLE ALWAYS':trigger.enabled==='R'?'ENABLE REPLICA':'ENABLE'} TRIGGER ${ident(trigger.name)}`);
  return archive.manifest;
 });
}
