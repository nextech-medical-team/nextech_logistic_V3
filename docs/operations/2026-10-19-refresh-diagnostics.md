# Relecture des incidents Erplain

Le bouton d’actualisation relit désormais le BC et ses BL pour les diagnostics de stock, de réponse API incomplète et de préparation des commandes non partielles ayant un BC enregistré. Sa propre tâche d’actualisation est exclue du verrou de lecture ; les autres tâches restent bloquantes. Une date absente du BL historique est relue dans Erplain uniquement si l’identité, les lignes et la politique de stock du BL sont inchangées.

La reprise distingue un BC absent, une identité inattendue, des lignes absentes de la réponse et un BC réellement vide. Les alertes client répétées sont regroupées ; la fenêtre indique le numéro client à rechercher dans Erplain.

Ces changements ne constituent pas une réparation des données de production. Un client dont la création précédente reste incertaine, un BC introuvable ou un achat TEMU incertain ne sont pas recréés automatiquement. Le refus des caractères d’adresse par TEMU reste une correction distincte à effectuer auprès de la plateforme ou du transporteur, après vérification de l’expédition existante.

Vérification après déploiement : actualiser une commande à la fois, contrôler les BC/BL et le diagnostic résultant. Pour les clients absents, vérifier le numéro indiqué dans Erplain avant toute création. Ne pas acheter une nouvelle étiquette pour contourner une tentative TEMU incertaine.

## Client absent : confirmation opérateur

Pour les commandes TEMU et Amazon encore à l’étape client, sans BC/BL ni mouvement de stock enregistré, la fenêtre client propose une confirmation explicite après vérification du numéro dans Erplain. La recherche complète est refaite à l’exécution : un client unique est réutilisé ; une absence complète permet de retirer le blocage de création et de reprendre les contrôles normaux. Une réponse incomplète, ambiguë ou en erreur ne vaut jamais absence. Une tentative datant de moins de 15 minutes bloque cette confirmation, afin de laisser vérifier son résultat.

L’autorisation est enregistrée avec l’identifiant de la tâche, le numéro client, l’ancienne identité et la tentative précédente. Elle ne s’applique qu’à l’état vérifié. Une nouvelle tentative interrompue revient au blocage normal et nécessite une nouvelle vérification. Les commandes partielles, suspendues, importées ou déjà dotées de documents restent exclues. Cette action ne réinitialise aucun BC, BL, stock ou achat d’étiquette.

La confirmation opérateur n’élimine pas le risque d’une réponse distante tardive : l’absence doit aussi être vérifiée dans Erplain. Le contrôle du client n’équivaut pas à une garantie de préparation complète ; les autres problèmes sont recalculés avant la reprise.
