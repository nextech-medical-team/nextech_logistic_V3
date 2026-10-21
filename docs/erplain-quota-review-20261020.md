# Retrait des anciennes attentes de quota Erplain

Branche : `fix/erplain-quota-review-20261020`, depuis `main` 014fc6c. Cette correction est indépendante de `fix/auto-transient-erplain-20261019` et ne libère aucune attente de préparation.

Le contrôle SSH/PostgreSQL en lecture seule du 20 octobre a trouvé des interventions en revue avec l'ancien message « Erplain temporairement limité : vérification et reprise automatiques programmées », alors que le worker ERP était déjà terminé avec un BC actif et un BL vérifié plus récemment. Certains dossiers conservaient une attente documentaire, des indicateurs de quota périmés ou un BL désormais expédié/livré. Les anciens filtres empêchaient la clôture du diagnostic.

La clôture des deux libellés exacts d'attente de quota se fonde sur la fin du worker sans erreur, la preuve de préparation/stock, l'identité des BC/BL enregistrés et une vérification postérieure au diagnostic ainsi qu'au dernier échec. La date de fin du job doit couvrir cette vérification. Une attente documentaire conservée ne bloque plus la seule clôture du diagnostic. Un BL déjà expédié/livré reste inchangé. Les archives, partielles, annulations, suspensions, travaux concurrents et preuves absentes ou périmées restent exclus.

Lorsqu'une erreur métier ERP plus récente a remplacé le quota, la revue affiche ce motif sans exiger la remise à zéro d'anciens indicateurs de quota. La commande reste en revue ; l'ancien message est conservé dans le résultat technique.

Les erreurs mixtes et les autres étapes ne sont pas assimilées à ces deux libellés. Aucune modification d'orders/erp_live_jobs, des tentatives, des échéances Retry-After, des BC/BL, du stock, des étiquettes ou paiements. Aucun appel fournisseur, achat ou remise en file n'est ajouté. Les quotas encore actifs conservent leur programmation et l'affichage de leur prochaine tentative existants.

Validation : tests SQL isolés du cas TEMU observé, indicateurs absents/périmés, BL expédiés/livrés, exclusions et conservation exacte des données métier ; tests existants des reprises, priorités et échéances de quota. Le nouveau test est inscrit dans le lanceur obligatoire. Aucun changement de production effectué ; publication et recette installée restent séparées.

Les 67 tests ciblés de clôture/quota/rapprochement ont réussi, ainsi que le contrôle syntaxique global de 717 fichiers JavaScript. La suite générale est également lancée avant envoi. Les lectures serveur confirment les preuves de fin ERP des dossiers concernés ; aucune revue de production n'a été modifiée pour cette validation.
