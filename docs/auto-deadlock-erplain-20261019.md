# Conflits de transaction pendant le rapprochement

Branche : `fix/auto-deadlock-erplain-20261019`. Base : `e18724e` (main, 19 octobre 2026).

La transaction locale de persistance du rapprochement réessaie après les codes PostgreSQL 40P01/40001. Les erreurs SQLSTATE[40P01] sont reconnues pour la récupération.

Au plus trois exécutions de la transaction locale, avec nouvelle vérification des versions et des tâches concurrentes. Aucun appel fournisseur dans la transaction réessayée.

## Validation

`node --test test/recovery-transaction.test.mjs test/erplain-transient-recovery.test.mjs test/erplain-recovery-fluidity.test.mjs`

27 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.
