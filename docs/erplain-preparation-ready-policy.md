# Statuts ERPLAIN : règle humaine du 12 octobre 2026

V3 peut envoyer le statut `ready_to_ship` (« prêt à livrer ») vers ERPLAIN, sauf lorsque le statut de base actuel dans ERPLAIN est `in_preparation` (« en préparation »). Cette transition précise est strictement interdite, dans tous les parcours automatiques et manuels, y compris les livraisons partielles et les reprises.

Avant toute mutation de statut vers `ready_to_ship` sur un document existant, V3 relit le statut ERPLAIN. Si le statut est `in_preparation`, aucun envoi de mutation n'a lieu et une erreur métier explicite est remontée. Si le statut source ne peut pas être vérifié, l'envoi est refusé. Les autres statuts de départ conservent leurs contrôles existants : cette règle ne les autorise pas à elle seule.

La lecture et l'affichage de `ready_to_ship` restent autorisés. Aucun statut existant, document, stock, étiquette ou historique ne doit être corrigé ou annulé rétroactivement par cette règle. La publication et la recette installée restent à la charge de Section7.
