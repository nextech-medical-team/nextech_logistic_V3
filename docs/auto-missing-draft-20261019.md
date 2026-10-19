# Brouillon BL réellement absent

Branche : `fix/auto-missing-draft-20261019`. Base : `e18724e` (main, 19 octobre 2026).

Le rapprochement automatique du brouillon absent utilise la preuve existante d’absence de mouvement pour tous les canaux du cycle BL natif admissible, au lieu du seul canal Amazon.

Cycle natif requis ; journal complet sans mouvement de cet ancien BL, absence de sortie distincte, de transport et de traitement concurrent. Seul le pointeur local est retiré ; la préparation normale crée ensuite son BL.

## Validation

`node --test test/erplain-recovery-fluidity.test.mjs test/missing-draft-recovery.test.mjs test/native-bl-policy.test.mjs`

87 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.
