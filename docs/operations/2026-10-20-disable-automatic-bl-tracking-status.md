# Statuts BL : suivi sans modification automatique

Le cycle Erplain exécuté en arrière-plan ne passe plus les BL à `shipped`
ou `delivered` à partir du suivi transporteur. La reprise du même cycle
ne réactive pas ces transitions.

Les événements de suivi restent lus et peuvent actualiser le suivi local V3.
Le statut du BL dans Erplain reste celui lu dans Erplain. Une observation
« livré » ne déclenche donc plus, à elle seule, la facturation de ce cycle.

La préparation à `ready_to_ship`, les annulations reconnues et le traitement
des factures des BL déjà livrés dans Erplain conservent leurs règles existantes.
La synchronisation explicitement demandée en mode `apply` depuis le service
de suivi ou le script dédié reste une action distincte ; ne pas la lancer
pour une simple consultation du suivi.

Ce changement nécessite le déploiement de cette version et le redémarrage
des workers. Il ne rétablit pas les statuts déjà modifiés dans Erplain.
