# Réponses Erplain incomplètes

Branche : `fix/auto-incomplete-erplain-20261019`. Base : `e18724e` (main, 19 octobre 2026).

Une réponse de lecture sans champ Order/ShippingOrder ou une liste BL incomplète est distinguée d’une absence confirmée. Les lectures sont reprises avec délai et plafond. Les résultats incomplets des créations client/BC et de publication BL passent par le rapprochement existant.

Une création BL sans identité ou une mutation de stock incertaine ne sont pas relancées automatiquement. Une absence explicite du BC reste à contrôler.

## Validation

`node --test test/erplain-transient-recovery.test.mjs test/erplain-recovery-fluidity.test.mjs test/amazon-recovery.test.mjs`

59 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.
