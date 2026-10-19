# BL publié après une réponse perdue

Branche : `fix/auto-bl-publication-20261019`. Base : `e18724e` (main, 19 octobre 2026).

La relecture par identifiant du brouillon accepte aussi ses états publiés ouverts. Un BL déjà publié peut donc être récupéré lorsque la liste du BC ne le renvoie pas encore.

Identifiant, rattachement unique au BC et politique stock doivent être confirmés. États terminaux refusés. La récupération effectue uniquement des lectures et conserve le BL.

## Validation

`node --test test/erplain-transient-recovery.test.mjs test/erplain-recovery-fluidity.test.mjs test/publication-recovery.test.mjs test/amazon-recovery.test.mjs`

67 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.
