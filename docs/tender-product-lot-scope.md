# Périmètre des lots obligatoires avant création d’un BL

Tous les produits des commandes Appel d’offres nécessitent la gestion des lots
et un numéro de lot nommé dans Erplain. Sur Amazon, TEMU et Shopify, cette
exigence supplémentaire concerne uniquement les variantes également présentes
dans une commande Erplain dont le gestionnaire est « Appel d’offres » ou
« Appels d’offres ». Les autres produits ne sont plus bloqués par ce contrôle.

Le lien est établi en lecture seule depuis les BC Erplain, avec le filtre
`VARIANT_ID / EXISTS`, puis vérification du gestionnaire et de la variante
dans les lignes retournées. Les documents historiques sont inclus, sans filtre
de date ou de statut. Il n’y a ni liste de produits locale à maintenir, ni
modification du réglage de traçabilité Erplain.

L’identité contrôlée est celle de la variante Erplain effectivement expédiée,
après mapping ou substitution, et non le SKU de la plateforme. Chaque variante
est lue une seule fois par contrôle. Une preuve positive suffit ; une exemption
requiert la lecture complète des pages. Les lectures sont bornées à 100 pages
de 100 commandes par variante. Une erreur API, une pagination incomplète ou une
identité incohérente conserve un blocage explicite par produit. Aucune exemption
n’est conservée entre deux tentatives.

Le contrôle commun protège les créations de BL complets et partiels. Pour les
partiels, seules les lignes sélectionnées sont contrôlées. La création du BC et
les parcours d’étiquettes de BL déjà existants restent indépendants de ce
contrôle. Les contrôles de stock et d’affectation des lots restent exécutés par
leurs parcours existants ; ce changement ne crée pas de lot et ne réserve pas
de stock.

Les requêtes et champs utilisés sont décrits dans la
[référence API Erplain des commandes](https://erplain.readme.io/reference/sales-orders-queries).
Le filtre a été accepté par l’API réelle et vérifié en lecture seule sur une
variante existante : les lignes renvoyées contenaient la variante demandée,
le gestionnaire et la pagination attendus. Aucune donnée client n’est incluse
dans cette preuve.

Préparation uniquement : aucun déploiement, aucune modification de production
et aucune écriture métier ne sont autorisés par ce changement local.
