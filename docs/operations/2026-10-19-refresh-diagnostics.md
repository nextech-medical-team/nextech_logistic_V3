# Relecture des incidents Erplain

Le bouton d’actualisation relit désormais le BC et ses BL pour les diagnostics de stock, de réponse API incomplète et de préparation des commandes non partielles ayant un BC enregistré. Sa propre tâche d’actualisation est exclue du verrou de lecture ; les autres tâches restent bloquantes. Une date absente du BL historique est relue dans Erplain uniquement si l’identité, les lignes et la politique de stock du BL sont inchangées.

La reprise distingue un BC absent, une identité inattendue, des lignes absentes de la réponse et un BC réellement vide. Les alertes client répétées sont regroupées ; la fenêtre indique le numéro client à rechercher dans Erplain.

Ces changements ne constituent pas une réparation des données de production. Un client dont la création précédente reste incertaine, un BC introuvable ou un achat TEMU incertain ne sont pas recréés automatiquement. Le refus des caractères d’adresse par TEMU reste une correction distincte à effectuer auprès de la plateforme ou du transporteur, après vérification de l’expédition existante.

Vérification après déploiement : actualiser une commande à la fois, contrôler les BC/BL et le diagnostic résultant. Pour les clients absents, vérifier le numéro indiqué dans Erplain avant toute création. Ne pas acheter une nouvelle étiquette pour contourner une tentative TEMU incertaine.
