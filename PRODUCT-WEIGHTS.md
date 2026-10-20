# Poids produits et poids de transport

La maintenance des poids est indépendante du canal de vente et du poids déclaré pour une étiquette. Un poids produit ERPLAIN réellement absent (null ou vide) est renseigné à **5 g par unité**. Toute valeur existante est préservée ; zéro, négatif ou malformé reste une erreur distincte, sans remplacement arbitraire.

Le worker `product-weights` traite au plus dix SKU par cycle de trente secondes, sous le quota partagé ERPLAIN. Les commandes apportent les demandes prioritaires et un parcours paginé du catalogue couvre aussi les produits sans commande. Les preuves sont renouvelées quotidiennement, ou après un nouveau diagnostic de poids. Les variantes ambiguës ou liées à des identités incompatibles restent à vérifier. Les autorisations d'écriture et les interrupteurs `product-weights` / `read-catalog` restent obligatoires.

Chaque envoi est précédé d'une relecture de l'identité active et d'un journal durable dans `erplain_weight_repairs`. Un résultat incertain ou interrompu est rapproché par lecture seule après reprise ; aucune nouvelle mutation n'est déduite de l'absence de confirmation. Une absence ultérieure après une réparation confirmée constitue une nouvelle tentative journalisée, avec conservation de la preuve précédente.

Les erreurs de lecture sont réévaluées après cinq minutes, au lieu d'attendre le cycle quotidien. Un refus du quota local avant tout appel HTTP est journalisé `not_sent` et peut être repris après une nouvelle lecture ; il reste distinct d'un résultat fournisseur incertain, qui n'autorise aucun rejeu.

`erplain_weight_checks` et le réglage `product_weight_maintenance` exposent les dernières lectures et erreurs. Les poids relus actualisent les caches et les diagnostics sans créer de liaison SKU permanente, changer les quantités/mappings, relancer une préparation, modifier un BC/BL, un stock ou une étiquette. Les métadonnées des expéditions protégées restent conservées. Les parcours réservés aux propriétaires et les appels d'offres restent hors reprise automatique de ce traitement.

Les nouvelles fiches sont créées avec 5 g lorsqu'aucun poids explicite n'est fourni, puis relues. Les petits poids explicites sont envoyés en grammes si la précision en kilogrammes serait perdue.

Le poids du colis est calculé à partir des poids produits multipliés par les quantités physiques. L'arrondi au gramme supérieur élimine uniquement le bruit flottant : 30 unités de 100 g réparties sur plusieurs lignes restent 3 kg, et un dépassement réel reste supérieur à 3 kg pour le routage GLS/GOFO.

Les comportements actuels des devis/étiquettes TEMU, y compris la reprise d'un poids de commande supérieur à 0,25 kg, et les forfaits déclarés directement à GLS/GOFO restent inchangés sur décision humaine du 17 octobre 2026. Aucun traitement de poids n'achète ni ne réémet une étiquette.
