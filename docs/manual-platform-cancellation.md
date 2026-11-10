# Actualisation manuelle des annulations

Dans le menu, ouvrir « Annulations Temu / Shopify », sélectionner Temu, Shopify ou les deux, puis cliquer sur « Actualiser les annulations ». Ouvrir la page ne déclenche aucune vérification. Le module parcourt toutes les commandes V3 non archivées des canaux sélectionnés, indépendamment des filtres affichés. Il n'importe pas de nouvelles commandes et ne démarre aucun contrôle périodique.

Le tableau affiche le compte rendu par commande. Chaque contrôle crée un rapport enregistré en base au fur et à mesure des résultats. La liste « Rapports récents » permet de rouvrir les 25 derniers rapports après navigation ou rechargement. Un nouveau contrôle conserve les anciens rapports. Le bouton « Export Excel » télécharge les résultats affichés au format `.xlsx`.

L’application des annulations met à jour le même rapport, y compris les refus et les commandes à vérifier. La vérification initiale est conservée séparément en base. Un rapport interrompu reste consultable mais ne permet pas l’application : lancer une nouvelle vérification complète. Les rapports terminés peuvent être rouverts pour appliquer les annulations restantes ; la plateforme est toujours relue avant toute application.

Dans « Commandes et livraisons », une annulation confirmée par la plateforme ou enregistrée dans V3 colore la ligne et ses actions en rouge. La couleur signale l’annulation ; elle ne remplace pas l’étape « Appliquer les annulations ».

Le calendrier unique « Commandes créées depuis le » vérifie le statut actuel des commandes créées entre la date choisie et le moment du lancement, bornes incluses. La fin est automatique et reste fixe pendant toute la lecture. Les heures locales sont converties en UTC. Sans date, tout l’historique est consulté. Les dates futures sont refusées. Les commandes sans date de création exploitable sont exclues et signalées lorsqu’une date est choisie ; la date d’import V3 ne remplace pas la date de création. Le bilan et l’export conservent la période vérifiée.

Chaque commande est relue directement sur sa plateforme. Shopify doit confirmer une date d'annulation ; un remboursement seul ne déclenche rien. Temu doit confirmer le statut 3 et la référence exacte sur la boutique identifiée de la commande. Pour Temu, V3 vérifie aussi chaque article et consulte ses expéditions : un article expédié, une expédition présente, une expédition déjà enregistrée dans V3 ou une lecture incomplète produit « À vérifier », sans suspension ni annulation. Les anciens rapports Temu sans cette vérification sont présentés comme non confirmés et doivent être actualisés ; les preuves historiques restent conservées.

« Actualiser les annulations » consulte les plateformes et enregistre les observations, sans suspendre ni annuler les commandes ou les documents Erplain. Le tableau distingue les annulations confirmées à appliquer et les annulations appliquées dans V3.

Après une vérification terminée, cliquer sur « Appliquer les annulations » pour traiter les annulations confirmées du tableau. Le bouton reste désactivé pendant la lecture, si elle est interrompue ou si aucune annulation ne reste à appliquer. Chaque commande est relue sur sa plateforme avant application ; une ancienne preuve ou un statut fourni par le navigateur ne suffit pas.

À l'application, une annulation confirmée suspend d'abord les traitements V3. Si un BC est associé, le mécanisme existant contrôle les documents Erplain, annule les BL admissibles puis le BC et relit leur statut. Après confirmation, V3 affiche la commande annulée. Sans BC, l'annulation est uniquement locale.

Les commandes expédiées, facturées, avec des documents partagés ou un mouvement de stock à rapprocher ne sont pas annulées dans Erplain. Elles restent suspendues et leur motif apparaît dans le bilan « à vérifier ». Les étiquettes et documents historiques restent conservés. Aucun remboursement ni annulation de transporteur n'est effectué.

Un résultat Erplain incertain est uniquement vérifié lors d'un nouveau passage : aucune mutation d'annulation n'est répétée. En cas d'interruption de la connexion, relancer le bouton pour recommencer le parcours. Garder la page ouverte pendant le contrôle.

Accès : opérateur, responsable ou administrateur. Chaque résultat est enregistré dans l'audit, avec l'utilisateur ; la preuve source est conservée dans `source_payload.manualPlatformCancellation`.

Validation locale : `node --test test/manual-platform-cancellation.test.mjs test/order-suspension-experience.test.mjs`.

## Traitement quotidien automatique

Le bouton « Activer / Désactiver l’annulation automatique » de la page Annulations Temu / Shopify affiche le réglage enregistré. Seul un administrateur peut le modifier. Il utilise le même interrupteur `platform-cancellation` que les réglages des tâches et reste enregistré après redémarrage. Désactivé, aucun nouveau contrôle ni aucune nouvelle application automatique ne démarre ; un passage commencé reste en attente et reprend à sa progression lors de la réactivation. Une opération externe déjà engagée peut se terminer. Les actions manuelles restent disponibles. Chaque changement est enregistré dans l’audit.

Le worker lance une vérification Temu et Shopify chaque jour à 7 h 30 (Europe/Paris ; configurable par `PLATFORM_CANCELLATION_TIMEZONE`). Un démarrage après cet horaire déclenche le passage du jour. Après vérification complète du rapport, les annulations confirmées sont appliquées avec relecture des plateformes et contrôles Erplain existants. Les refus restent visibles dans le rapport. Les rapports automatiques sont accessibles dans le même historique que les rapports manuels.

La progression est conservée en base et reprend après redémarrage. Un passage terminé ne se répète pas le même jour. Le traitement peut être suspendu par `platform-cancellation` dans les interrupteurs des tâches. Un worker actif est nécessaire. Ce traitement quotidien fonctionne indépendamment de la page manuelle.
