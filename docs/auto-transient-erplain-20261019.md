# Incidents Erplain en attente

Branche : `fix/auto-transient-erplain-20261019`. Base : `e18724e` (main, 19 octobre 2026).

Les anciens messages « reprise automatique en attente (0/3) » restent éligibles au rapprochement même si lastError manque. Le contrôle relit les documents puis remet la tâche en attente de préparation.

Trois tentatives maximum ; commandes suspendues, archivées, partielles ou en attente de validation exclues.

## Validation

`node --test test/erplain-transient-recovery.test.mjs test/erplain-recovery-fluidity.test.mjs test/erplain-live-recovery.test.mjs`

30 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.
