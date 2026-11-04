# Réconciliation des remplacements — 4 novembre 2026

Le déploiement de `faa625bd96ec1fb519763790170892ecc9299302` a été refusé
avant installation : `src/stock-substitution.mjs` différait de la référence
enregistrée sur le serveur. La comparaison fraîche a confirmé deux modules
liés, sans inclure les autres écarts de production.

Le commit de provenance `6ca5d92` conserve les octets exacts de ces modules :

| Fichier | SHA-256 serveur |
| --- | --- |
| src/stock-substitution.mjs | 76772a4fe88078e443decf93a07cacc6b453dbf77acc1c55cb83359ab998978c |
| src/substitution-recovery.mjs | 3c7e89f458cd730c1ed55bc177e544ddc3e66e5f4cd6086e55628f46a32e4ed5 |

Le candidat final conserve ces protections : enregistrement de l'aperçu
historique avant écriture, récupération sans tâche de prévisualisation séparée,
et nouvelle prévisualisation après refus de lots uniquement si le BC et les
preuves de stock restent inchangés. Il conserve aussi le contrôle du mapping
de la PR #312 avant tout appel fournisseur. Aucun changement de calcul des
prix, de données de commande ou de configuration privée n'est inclus.

Avant publication, Section 7 doit vérifier sous le verrou de déploiement
que les octets serveur sont toujours ceux du commit de provenance, faire
valider le candidat par la fusion à trois voies de `reconcile_overlay_sources`,
sauvegarder la référence puis enregistrer uniquement ces deux overlays avec
leur provenance Git. La référence de commit déployé ne doit pas être avancée
à cette étape. Une divergence supplémentaire doit bloquer l'opération.
La publication reste confiée au workflow manuel avec ses tests et sauvegardes.
