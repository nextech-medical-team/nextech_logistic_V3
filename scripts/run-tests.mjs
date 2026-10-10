import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['--test','test/problem-typology.test.mjs','test/weight-business-policy.test.mjs','test/correction-status-check.test.mjs','test/status-reconciliation-db.test.mjs','coordination-deploiement/publication-readiness.test.mjs','coordination-deploiement/queue-paths.test.mjs'],{stdio:'inherit'});process.exit(r.status??1);
