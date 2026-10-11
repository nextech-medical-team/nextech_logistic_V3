# Vérification des statuts après correction

Après chaque intervention réussie dans les circuits résolution, résolution différée et correction, relire les diagnostics locaux courants avant d'enregistrer la fin. Conserver dans le résultat `statusVerification` : date, état, problèmes restants et portée des preuves. Si la lecture échoue, ne pas annoncer une vérification réussie ; conserver une intervention à vérifier sans rejouer une mutation externe. Une intervention effectuée ne signifie jamais une commande livrée ou entièrement résolue.

Les messages de poids sont rapprochés avec une liaison Erplain vérifiée depuis moins de 24 heures : identité et variante physique identiques, produit actif, poids réellement présent, preuve plus récente que le message. Actualiser toutes les copies exactes concernées, y compris les comptes rendus de remplacement et les contrôles ERP. Garder les stocks insuffisants, les autres erreurs, les suspensions, les confirmations de remplacement et tous les états métier. Ne pas modifier les étiquettes, documents ou mouvements. Le rapprochement est idempotent et transactionnel. Un contrôle périodique, au maximum une fois par minute, couvre aussi les corrections de poids faites hors des circuits V3 lorsque leur preuve a été actualisée.

La lecture de statut utilise les rapprochements existants pour les diagnostics financiers et colis partagés. Elle expose les autres erreurs et traitements en cours au lieu de les effacer. Elle n'effectue pas une lecture fraîche de tous les fournisseurs : un blocage inconnu ou sans preuve récente demeure à vérifier. Ajouter un rapprochement spécifique et des tests pour chaque nouvelle famille ; ne jamais remplacer les statuts globalement par « terminé ».


## Poids historiques et nouveaux parcours

Après une relecture de poids, le helper rapproche immédiatement les messages commande/ERP/remplacement, sans attendre un worker périodique. Les correspondances SKU sont prises en compte, avec conservation de la variante physique sélectionnée. Le cache zéro de la même variante est remplacé par le poids relu ; aucune autre variante n'est modifiée.

Un message générique de poids commande n'est retiré qu'après une preuve récente, plus récente que le message, pour toutes les lignes et quantités. Un SKU réellement non retrouvé garde un diagnostic catalogue explicite. Un nombre de colis absent et une synchronisation catalogue ne sont pas des poids produit manquants. Le routage arrondit les petits poids positifs vers le haut au gramme ; il ne remplace pas leur valeur produit par 5 g.

Validation : suite SQL réelle, chemins de correspondance/variante/cache zéro, défaut 5 g et unités inconnues, matrice de 224 combinaisons, lecture de toute la population historique installée et vérification après publication. Cette recette n'effectue aucun achat, mouvement de stock, BC/BL, reprise ou réémission d'étiquette. Les autres blocages métier restent visibles.
