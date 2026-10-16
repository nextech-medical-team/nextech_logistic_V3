# Mapping modifié après création du BC

Un mapping permanent prépare les commandes qui n'ont pas encore de BC. Il ne
remplace pas les produits d'un BC existant. Pour ce dernier, utiliser le parcours
d'équivalence qui relit le document et confirme le résultat ERPLAIN avant de
synchroniser les lignes V3 et de reprendre la préparation.

Le défaut reproduit associe un ancien produit du BC, 360 unités, à un mapping
ultérieur vers un autre produit. La liste attribuait la rupture de l'ancien SKU
au nouveau SKU, puis le formulaire proposait de remplacer ce nouveau SKU absent
du BC. Une actualisation seule ne pouvait pas appliquer l'équivalence.

Le contexte du formulaire choisit désormais les lignes normales du BC enregistré
et leurs unités ERPLAIN. Un instantané incomplet demande une relecture, sans
retomber sur le mapping permanent. Le moteur de substitution conserve ses
relectures finales, contrôles du stock du remplacement et protection des écritures
incertaines. Aucune substitution automatique n'est déduite d'un mapping.

Les mappings permanents ne remettent plus à zéro les lignes/jobs des commandes
ayant un BC. Le mapping limité à une commande avec BC renvoie vers l'équivalence
avant toute écriture. La préparation locale conserve sa sélection enregistrée et
ne réécrit plus ses lignes depuis un mapping ultérieur. Le badge de stock reprend
le SKU explicite du diagnostic fournisseur au lieu de son alias dans la liste.

Le parcours de préparation des appels d'offres est conservé. Aucun contrôle BC,
stock ou mapping n'est ajouté au parcours d'étiquette après création du BL. Aucun
statut ERPLAIN, mouvement de stock, document ou PDF existant n'est modifié par la
publication de ce correctif. Les anciens dossiers divergents exigent leur propre
remplacement explicite et une vérification après enregistrement.

Validation : test de reproduction du sélecteur, unités, réponse incomplète,
lignes multiples/partielles, diagnostic multi-SKU, mapping après BC et exécution
SQL réelle en PGlite pour la préservation des BC/jobs. Le classificateur partagé
alimente badges et filtres. Vérification visuelle isolée ordinateur/mobile,
non-régression générale et CI exacte avant publication Section7.
