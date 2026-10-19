# Client Erplain créé mais non confirmé

Branche : `fix/auto-customer-reconcile-20261019`. Base : `e18724e` (main, 19 octobre 2026).

Le diagnostic dédié de création client déclenche une recherche automatique par identité, même sans ancienne erreur réseau enregistrée. Une correspondance unique est réutilisée avant le contrôle normal de préparation.

Absence, ambiguïté et identité différente restent bloquées ; nouvelle création autorisée uniquement par la preuve existante de rejet sans écriture. Trois contrôles bornés hors attente de quota admissible.

## Validation

`node --test test/erplain-transient-recovery.test.mjs test/customer-creation-recovery.test.mjs test/erplain-recovery-fluidity.test.mjs`

31 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.
