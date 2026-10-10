import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['--test','test/problem-typology.test.mjs','coordination-deploiement/publication-readiness.test.mjs'],{stdio:'inherit'});process.exit(r.status??1);
