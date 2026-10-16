# Commande livrée : aucun problème à gérer

Décision humaine du 15 octobre 2026 : dès que V3 constate la livraison de la commande, la même requête retire tous les diagnostics actifs, sans tâche différée. Cette décision remplace les anciennes exceptions qui conservaient une erreur indépendante sur une commande livrée.

Le statut logistique de commande `delivered` suffit. Une lecture ERPLAIN complète suffit également si tous les BL non annulés sont livrés et toutes les quantités produit du BC sont expédiées. Un BL livré au milieu de livraisons ouvertes, un reliquat non expédié, `shipped`, un code de plateforme indicatif ou un état simulé ne constituent pas une livraison complète.

La décision est commune au navigateur et au serveur ; son équivalent SQL retire les commandes livrées avant pagination, compteurs et export. La projection de réponse retire les anciens diagnostics de préparation, produits, remplacements et transport. La relecture ERPLAIN retourne la livraison dans la requête qui la constate, avant les contrôles de préparation/stock. Aucun document ou job n'est annulé, aucun achat relancé, aucun statut ERPLAIN modifié et aucune erreur historique persistée n'est effacée.

Tests : `node --test test/delivered-zero-problems.test.mjs`, inclus dans `npm test`. Publication exclusivement Section7, avec recette de la version installée. L'inscription de cette règle ne prouve pas sa publication.
