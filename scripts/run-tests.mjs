import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['--test','test/problem-typology.test.mjs','test/platform-observers.test.mjs','test/platform-sql-policy.test.mjs','test/platform-view.test.mjs','coordination-deploiement/publication-readiness.test.mjs','coordination-deploiement/queue-paths.test.mjs'],{stdio:'inherit'});process.exit(r.status??1);
