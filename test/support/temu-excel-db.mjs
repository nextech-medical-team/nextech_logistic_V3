import {PGlite} from '@electric-sql/pglite';
export async function createTemuExcelTestDatabase(dataDir){
 const db=new PGlite(dataDir);await db.exec(`
 CREATE TABLE IF NOT EXISTS orders(id text primary key,channel text,reference text,source_reference text,recipient text,address jsonb,source_date text,source_payload jsonb,carrier text,label_status text,erp_status text,erp_test jsonb,tracking_status text,resolution_pending_resume boolean,suspension jsonb,issue text,archived boolean default false,UNIQUE(channel,reference));
 CREATE TABLE IF NOT EXISTS lines(id text primary key,order_id text references orders(id),source_line text,source_sku text,quantity numeric,source_payload jsonb,UNIQUE(order_id,source_line));
 CREATE TABLE IF NOT EXISTS import_receipts(id text primary key,signature text,result jsonb);
 CREATE TABLE IF NOT EXISTS order_suspension_events(id text primary key,order_id text,action text,user_email text,note text,state jsonb);
 CREATE TABLE IF NOT EXISTS audit(user_email text,action text,detail jsonb);
 CREATE TABLE IF NOT EXISTS jobs(id text,order_id text);`);return db;
}
