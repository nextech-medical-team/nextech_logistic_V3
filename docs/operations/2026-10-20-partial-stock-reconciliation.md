# Rapprochement du stock à l’actualisation des BL

Cas signalé : PHARM828087, BC C00014955 (1934948), BL SH000745465
(1927302), bloquant une nouvelle livraison du produit 90.100.10.
Ces identifiants proviennent des captures ; aucune donnée de production n’a été modifiée.

L’actualisation d’une livraison existante sans preuve locale recherche désormais
la sortie de stock portant sa référence technique exacte V3PS-<delivery.id>.
Elle la rattache seulement si elle est unique, terminée, avec mise à jour du stock,
et si les produits, emplacements et quantités correspondent au BL relu.

Si le BC gère le stock, la recherche doit être vide et aucune sortie séparée connue
ne doit exister. Les journaux BC/BL sont alors vérifiés avec les règles historiques
existantes avant d’enregistrer une preuve de gestion native du stock.
Un journal absent, une réservation sans débit confirmé, une réponse incomplète,
une ambiguïté ou des quantités différentes conservent le blocage.

La sauvegarde vérifie que la commande et ses livraisons n’ont pas changé pendant
la lecture. Aucun document Erplain, statut transporteur ou PDF n’est créé/modifié.

Après déploiement : rechercher PHARM828087 et actualiser son BL dans V3.
Si la preuve est retrouvée, reprendre la préparation de 335230. Si une anomalie
subsiste, utiliser le diagnostic retourné ; ne pas créer un mouvement en doublon.
