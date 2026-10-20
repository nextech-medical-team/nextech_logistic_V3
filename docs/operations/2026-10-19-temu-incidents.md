# Vérification et reprise ciblée des dix commandes TEMU

Source : captures fournies par l'utilisateur le 19 octobre 2026. Les références doivent être retrouvées exactement dans la base de production avant toute action. Aucun état réel n'a été modifié dans cette intervention : la connexion SSH disponible a été refusée.

| Référence | Observation de la capture | Contrôle avant reprise |
| --- | --- | --- |
| PO-141-19324505836150369 | C0015985 / SH000745195 ; date du journal BL absente | Relire BC et BL avec created_at, puis rapprocher le journal existant. |
| PO-069-05644758794871011 | C0016018 brouillon introuvable / identité V3 absente | Recherche exhaustive du BC par identité V3 et rapprochement du numéro. Ne pas recréer un BC sur la seule absence d'une réponse. |
| PO-098-05500824453750141 | Client à vérifier / 429 | Respecter l'attente fournisseur, rechercher le client existant ; nouvelle création seulement si absence d'écriture prouvée. |
| PO-069-05692133458551049 | Client à vérifier / 429 | Même procédure. |
| PO-069-06105146716793771 | C0016099 brouillon / rapprochement ambigu | Relire BC, relations BL, preuve d'identité et résultat de publication avant reprise. |
| PO-069-06130651628153619 | C0016034 brouillon / réponse incomplète | Relecture complète ; une réponse partielle ne prouve pas l'absence du document. |
| PO-162-16619701422690619 | Client à vérifier / BC absent | Rechercher le client de cette commande avant toute création. |
| PO-069-16973345833592991 | C0016282 / SH000745434 ; réservation non confirmée | Réactualiser documents et diagnostic historique ; contrôler réservation BC et débit BL séparément. |
| PO-069-17168131932793876 | C0016286 / SH000745435 ; réservation non confirmée | Même procédure. |
| PO-069-04206322238070369 | C0016185 / SH000745359 ; incident temporaire | Rapprocher publication et état réel du BL existant ; conserver le BL. |

## Corrections réunies

- Intégration des corrections précédentes de reprise Erplain avec main, en conservant la création du BC sans blocage de stock et le contrôle avant BL.
- Isolation des erreurs par BL dans les lectures groupées et conservation du code de limitation API.
- Lecture de created_at dans tous les BL renvoyés par la lecture documentaire, y compris les pages supplémentaires. Cette date est indispensable au périmètre du journal historique.
- Nouvelle évaluation d'un diagnostic de stock précédemment non vérifiable, même si les anciennes erreurs des tâches sont absentes. Seul le diagnostic dont la provenance de stock est connue et qui correspond encore à l'erreur courante est éligible ; une nouvelle erreur indépendante reste intacte.

## Reprise en production

1. Vérifier la version réellement installée, les conflits documentés dans docs/deployment/2026-10-19-reconciliation.md et l'état des workers. Un commit Git fusionné ne prouve pas son déploiement.
2. Retrouver les dix références exactement ; conserver un état initial des identifiants BC/BL, tâches, diagnostics, colis, PDF et mouvements de stock.
3. Utiliser les actions applicatives existantes d'actualisation Erplain, une commande à la fois. Respecter les délais de quota et les traitements déjà actifs.
4. Pour les documents rapprochés sans ambiguïté, utiliser la reprise Erplain applicative. Conserver les tâches et leur historique ; ne pas forcer des états SQL, effacer les pointeurs BC/BL ou déclarer un débit de stock sans preuve.
5. Relire le résultat après chaque reprise. Vérifier qu'aucun BC, BL, débit ou achat d'étiquette n'a été dupliqué. Les étiquettes déjà présentes sont conservées ; cette opération ne commande pas un achat supplémentaire.
6. Rapporter séparément les commandes résolues, celles en attente du quota, et celles nécessitant une vérification documentaire humaine.

Les captures seules ne permettent pas de certifier le stock réel, la présence des documents chez Erplain ou la résolution des dix incidents.
