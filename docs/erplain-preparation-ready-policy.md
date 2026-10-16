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
