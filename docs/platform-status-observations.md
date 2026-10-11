# Statuts des plateformes — règle approuvée le 10 octobre 2026

Shopify, TEMU et Amazon déclarent des états commerciaux qui restent indicatifs. Expédition, expédition partielle, annulation, remboursement, demande d'annulation et statut inconnu ne constituent jamais un veto de préparation V3. Les articles, quantités et adresses réellement modifiés restent à rapprocher. Les suspensions humaines V3 et les documents Erplain annulés restent protégés.

Le tableau distingue le suivi logistique réel des colis (API transporteur ou événements `temu.track.trackinginfo.get`), les statuts des BL Erplain et les déclarations de la plateforme avec leur date de lecture. Une divergence entre ces colonnes ne bloque pas la commande. Les lectures de suivi absentes, périmées ou incompatibles avec l'identité du colis donnent un suivi inconnu.

La réception et les observations de cancellation ne déclenchent aucune annulation Erplain, restitution de stock, annulation d'étiquette ni remise en file. Le suivi TEMU continue après une déclaration de cancellation. Les étiquettes TEMU restent exclusivement dans le parcours TEMU.

## Retenues historiques

`platform-hold-maintenance.mjs` est une maintenance ponctuelle réservée à Section7, hors des workers et des routes HTTP. Elle exige le verrou de publication hérité, un inventaire explicite des services écrivains arrêtés proprement et une lecture fournisseur fraîche. Elle verrouille les tables, compare toutes les preuves puis retire uniquement la retenue technique, sans nouveau job ni appel d'écriture externe. La révision lifecycle est alignée sans demander de traitement. Un problème commercial, documentaire ou de résolution indépendant remplace le motif plateforme en conservant les états opérationnels.

Le rapport privé est enregistré avant chaque correction et après vérification. Il conserve les champs techniques antérieurs pour un retour arrière contrôlé sous la même pause. Il contient des données de commandes et doit rester hors Git, avec accès limité.

Le périmètre nominatif des réimports TEMU déjà autorisés est désormais chargé depuis `DATA_DIR/temu-authorized-reimport-scope.json`. Cette liste privée doit être extraite à l'identique de la version serveur précédente avant sa substitution. Elle ne doit jamais être commitée. Son absence ferme le réimport concerné ; elle ne donne aucune nouvelle autorisation d'import.

## Vérifications

Le circuit automatique teste réception réelle, protections de version, absence d'annulation externe, sélection SQL, distinction des trois vues, maintenance transactionnelle, conservation des problèmes indépendants et autorisation privée TEMU. Les contrôles avant publication incluent PostgreSQL réel dans une base temporaire isolée, performances en lecture seule et recette ordinateur/mobile. Section7 publie, contrôle les services et les sources installées ; le propriétaire vérifie ensuite les commandes réelles et le parcours installé.
