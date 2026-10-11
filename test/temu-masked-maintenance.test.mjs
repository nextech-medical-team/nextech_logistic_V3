import test from 'node:test';import {PGlite} from '@electric-sql/pglite';import {createSchema,exercise} from './helpers/masked-maintenance.mjs';
const facade=e=>({query:(...a)=>e.query(...a),exec:s=>e.exec(s),transaction:f=>e.transaction(t=>f(facade(t)))});
test('historical maintenance executes atomically, preserves invoice/documents/jobs, rolls back and refuses unsafe replay',async()=>{const e=new PGlite(),db=facade(e);try{await createSchema(db);await exercise(db);}finally{await e.close();}});
