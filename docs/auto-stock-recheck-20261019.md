# Diagnostics stock historiques devenus périmés

Branche : `fix/auto-stock-recheck-20261019`. Base : `e18724e` (main, 19 octobre 2026).

Le contrôle périodique existant peut réévaluer les deux anciens diagnostics exacts « emplacement incomplet » et « BC disponible, préparation du BL suspendue ». Une preuve complète retire le diagnostic obsolète et son badge ; le contrôle normal de préparation reste requis.

Le manque réel, les erreurs mixtes et l’absence de preuve restent bloqués. Le message brut Erplain nécessaire à la reprise existante est conservé. Aucun mouvement ni étiquette créé par le diagnostic.

## Validation

`node --test test/stock-incident-recheck.test.mjs test/stock-resume-watch.test.mjs`

36 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.
