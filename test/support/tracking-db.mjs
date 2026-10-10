const {PGlite}=await import(process.env.NEXTECH_TEST_PGLITE_MODULE||'@electric-sql/pglite');
export async function createTrackingTestDb(){
 const db=new PGlite();
  await db.exec(`
   CREATE TABLE orders(id text primary key,reference text,channel text,carrier text,transport_choice text,simulation boolean DEFAULT false,partial_mode boolean DEFAULT false,suspension jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',erp_live jsonb,archived boolean DEFAULT false,tracking_status text);
   CREATE TABLE carrier_jobs(order_id text primary key,carrier text,environment text,status text,tracking jsonb);
   CREATE TABLE extra_parcels(id text,order_id text,carrier text,environment text,status text,tracking text);
   CREATE TABLE partial_deliveries(id text,order_id text,carrier text,environment text,status text,tracking jsonb,bl jsonb);
   CREATE TABLE temu_label_jobs(reference text,packages jsonb,status text,result jsonb);
   CREATE TABLE document_lifecycle(bl_id text primary key,order_id text,partial_id text,locked boolean DEFAULT false);
   CREATE TABLE audit(user_email text,action text,detail jsonb);
   CREATE TABLE settings(key text primary key,value jsonb);
   CREATE TABLE carrier_tracking_cooldown(carrier text,environment text,until_at timestamptz,PRIMARY KEY(carrier,environment));
   INSERT INTO settings VALUES('background_tasks','{"lifecycle":false}');
   INSERT INTO orders(id,reference,channel,erp_live) VALUES ('o1','REF1','amazon','{"bc":{"id":"10"},"bl":{"id":"20"}}');
   INSERT INTO carrier_jobs VALUES('o1','gls_pharma','production','ready','["TRACK1"]');
   INSERT INTO extra_parcels VALUES('x1','o1','gls','production','ready','TRACK2');
   INSERT INTO orders(id,reference,channel,erp_live,partial_mode) VALUES ('o2','REF2','amazon','{"bc":{"id":"11"}}',true);
   INSERT INTO partial_deliveries VALUES('p1','o2','gofo','production','ready','["TRACK3"]','{"id":"21","status":"shipped"}');
   INSERT INTO partial_deliveries VALUES('p2','o2','gofo','test','ready','["TEST4"]','{"id":"22"}');
   INSERT INTO orders(id,reference,channel,simulation,erp_live,source_payload) VALUES ('o3','PO-1-2','temu',true,'{"bc":{"id":"12"},"bl":{"id":"23"}}','{"mallId":"mall"}');
   INSERT INTO temu_label_jobs VALUES('PO-1-2','["PK-1"]','complete','{"source":"temu_direct"}');
  `);
 await db.exec(`CREATE TABLE worker_health(id text,role text,heartbeat timestamptz DEFAULT now(),state jsonb);INSERT INTO worker_health VALUES('test','worker',now(),'{"tasks":[{"name":"tracking-sync","enabled":true}]}');`);
 return db;
}
