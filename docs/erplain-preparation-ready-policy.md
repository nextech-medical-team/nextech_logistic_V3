# Statuts ERPLAIN : règle humaine du 12 octobre 2026

V3 peut envoyer le statut `ready_to_ship` (« prêt à livrer ») vers ERPLAIN, sauf lorsque le statut de base actuel dans ERPLAIN est `in_preparation` (« en préparation »). Cette transition précise est strictement interdite, dans tous les parcours automatiques et manuels, y compris les livraisons partielles et les reprises.

Avant toute mutation de statut vers `ready_to_ship` sur un document existant, V3 relit le statut ERPLAIN. Si le statut est `in_preparation`, aucun envoi de mutation n'a lieu et une erreur métier explicite est remontée. Si le statut source ne peut pas être vérifié, l'envoi est refusé. Les autres statuts de départ conservent leurs contrôles existants : cette règle ne les autorise pas à elle seule.

La lecture et l'affichage de `ready_to_ship` restent autorisés. Aucun statut existant, document, stock, étiquette ou historique ne doit être corrigé ou annulé rétroactivement par cette règle. La publication et la recette installée restent à la charge de Section7.

## Débit et reprise du quota Erplain

Pour `https://api.erplain.app/graphql`, les connecteurs utilisent un espacement partagé de 600 ms (environ 100 requêtes par minute hors pauses), sous la limite officielle v2 de 2 appels HTTP par seconde. Les autres endpoints conservent 1 600 ms. La file commune et la priorité des préparations sur les lectures de fond restent actives ; le débit concerne tous les connecteurs ensemble.

Un `Retry-After` valide est respecté sans imposer systématiquement une minute supplémentaire (minimum local de 1 seconde au transport et 2 secondes pour la remise en file). En l’absence de délai exploitable, le repli progressif de 60 secondes à 15 minutes reste appliqué. Une pause partagée plus longue déjà enregistrée ne peut pas être raccourcie. Les écritures ne sont pas rejouées par le transport ; les réponses partielles sont préservées.

Source vérifiée le 15 octobre 2026 : [limites officielles Erplain v2](https://erplain.readme.io/v2.0/reference/throttling). Il s’agit d’une capacité d’envoi, pas d’un délai garanti de préparation d’une commande.


## Récupérer des documents sur une commande existante

Le parcours ciblé propose un rattachement explicite lorsque le BC, sa référence externe ou la référence source correspondent à une seule commande V3. Il relit le BC et tous les BL avant validation ; une modification depuis l’aperçu impose une nouvelle lecture. Plusieurs correspondances, un autre BC déjà rattaché ou un traitement actif bloquent le rattachement.

Cette action récupère tous les BL, notamment un deuxième BL en préparation à côté d’un premier BL livré. Elle conserve le BL principal déjà sélectionné, les lignes source, les étiquettes, les traitements et l’état archivé. Elle ne lance aucune préparation et ne modifie aucun document Erplain. Les avertissements de stock ou d’adresse restent des diagnostics de préparation et ne bloquent pas cette récupération documentaire. Les BL sont consultables dans « BL associés » de la commande existante.

Le contrôle affiche chaque correspondance avec sa référence, son identifiant V3, le motif de correspondance et son état archivé, ainsi qu’un accès direct à son détail. La recherche générale inclut `source_reference`. La liste des commandes récupérées inclut aussi les commandes marketplace rattachées par `erplain_order_identity`, même archivées ; un rattachement ne les réactive pas. En l’absence de correspondance, le parcours normal de validation/import reste disponible.

## Réactiver une commande dont l’import local a été annulé

Dans Réceptions ERPLAIN, une commande archivée par `importCancellation` avec le périmètre `import_only_not_marketplace` peut être réactivée explicitement en sélectionnant un BL `pending` du BC actif déjà rattaché. Les circuits Amazon, Shopify hors circuit relais, et Erplain utilisent la reprise transport partielle existante. Les suspensions, annulations métier, autres causes d’archivage et traitements actifs/incertains restent bloqués.

Le serveur relit les documents et compare l’empreinte de l’aperçu avant de modifier V3. Une seule livraison partielle est enregistrée pour le BL sélectionné, avec ses propres SKU et quantités Erplain. L’action conserve les lignes source, l’ancien BL principal, les PDF, les suivis et l’annulation d’import ; l’état antérieur est enregistré dans l’audit et `archivedBlRecovery`. La commande redevient visible et utilise le circuit partiel. Aucun appel de mutation Erplain ni achat transporteur ne se produit lors de la réactivation.

La livraison reste à confirmer (`review` / `recovered_bl`). « Voir la livraison reprise / lancer son étiquette » ouvre directement l’historique des livraisons, sans proposer la création d’un nouveau BL. « Reprendre l’étiquette sans recréer le BL » lance ensuite le parcours transport existant. Les relectures de stock ne doivent pas démarrer cet achat automatiquement.

### Affichage et étiquette d’un BL repris après archivage

Lorsqu’un BL existant est repris et qu’aucune autre livraison locale n’est encore à traiter, la liste présente une seule ligne opérationnelle : référence et date de la commande, BC, BL repris, articles et quantités de ce BL. Les BL précédents restent dans l’historique. Les autres livraisons encore actives conservent leurs lignes distinctes.

Le bouton habituel « Créer les étiquettes transporteurs PROD » dirige cette sélection vers la reprise d’étiquette du BL existant. Le traitement utilise les règles transport du canal (notamment Amazon), les quantités du BL et les protections existantes contre une seconde création. Il ne relance pas la création du BC, du BL ou d’une sortie de stock. Le téléchargement de la sélection vise également les documents de ce BL. Si les données du BL repris ne sont pas chargées, la création demande d’actualiser la liste au lieu de traiter l’ancienne expédition globale.
