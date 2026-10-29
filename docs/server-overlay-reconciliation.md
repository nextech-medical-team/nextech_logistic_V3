# Conservation des correctifs serveur lors de la publication Shopify

La publication du commit `6f000415be04ea4239e0c9bf5de009d649228f93`
était refusée avant installation : la cible ne conservait pas les correctifs de
`src/erplain-live-workflow.mjs` enregistrés dans la référence serveur
`affaec80ee60e45c9fbfa8012b6f4b5da6b147c6`.

L'intégration conserve la séparation des adresses Shopify et reprend les
correctifs serveur vérifiés : contrôle des lots avant création du BL et
rapprochement en lecture du débit physique du BC. Les modules
`bl-batch-required.mjs` et `native-bc-debit-recovery.mjs` entrent dans Git avec
les mêmes octets que leurs versions enregistrées sur le serveur. Le contrôle
des lots ne bloque plus la création du bon de commande.

Provenance des sources conservées :

- Workflow et compatibilité du contrôle des lots :
  `a697d8fd40affb57ccde846e0c3c08a8994290b8`.
- Contrôle des lots : `ca597a3123f9f84139d3d7db90445d003d50c732`.
- Rapprochement du débit BC : `87d985e99873608849197c1f26839f43349972bb`.

## Exécuteur de publication

`deploy/plan.py` accepte désormais l'entrée dans Git d'un fichier déjà présent
sur le serveur uniquement si sa provenance Git, son empreinte de référence,
ses octets actuels et les octets du candidat correspondent tous exactement.
Cette adoption n'installe pas le fichier et ne modifie pas la référence serveur.
Une modification concurrente, une provenance différente ou une cible différente
reste refusée.

La version corrigée de `plan.py` doit être installée dans l'exécuteur de
confiance par le circuit Section 7 avant la publication applicative. Un push ou
une fusion ne remplace pas `/usr/local/lib/nextech-cicd/plan.py`.
Conserver la file commune, le verrou de publication et les contrôles de
provenance ; ne pas supprimer les entrées `preservedOverlays` pour contourner
l'erreur. Après fusion, lancer le workflow manuel sur le nouveau SHA de `main`,
pas sur l'ancien commit refusé.

Cette intégration ne modifie aucune commande, étiquette, facture, stock ou
configuration fournisseur.
