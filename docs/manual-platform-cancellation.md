# Actualisation manuelle des annulations

Dans le menu, ouvrir « Annulations Temu / Shopify », sélectionner Temu, Shopify ou les deux, puis cliquer sur « Actualiser les annulations ». Ouvrir la page ne déclenche aucune vérification. Le module parcourt toutes les commandes V3 non archivées des canaux sélectionnés, indépendamment des filtres affichés. Il n'importe pas de nouvelles commandes et ne démarre aucun contrôle périodique.

Le tableau affiche le compte rendu par commande et reste disponible pendant la navigation dans l’application. Le bouton « Export Excel » télécharge les résultats affichés au format `.xlsx`. Un nouveau contrôle remplace le bilan précédent ; un rechargement du navigateur efface ce bilan.

Le calendrier unique « Commandes créées depuis le » vérifie le statut actuel des commandes créées entre la date choisie et le moment du lancement, bornes incluses. La fin est automatique et reste fixe pendant toute la lecture. Les heures locales sont converties en UTC. Sans date, tout l’historique est consulté. Les dates futures sont refusées. Les commandes sans date de création exploitable sont exclues et signalées lorsqu’une date est choisie ; la date d’import V3 ne remplace pas la date de création. Le bilan et l’export conservent la période vérifiée.

Chaque commande est relue directement sur sa plateforme. Shopify doit confirmer une date d'annulation ; un remboursement seul ne déclenche rien. Temu doit confirmer le statut 3 et la référence exacte sur la boutique identifiée de la commande.

« Actualiser les annulations » consulte les plateformes et enregistre les observations, sans suspendre ni annuler les commandes ou les documents Erplain. Le tableau distingue les annulations confirmées à appliquer et les annulations appliquées dans V3.

Après une vérification terminée, cliquer sur « Appliquer les annulations » pour traiter les annulations confirmées du tableau. Le bouton reste désactivé pendant la lecture, si elle est interrompue ou si aucune annulation ne reste à appliquer. Chaque commande est relue sur sa plateforme avant application ; une ancienne preuve ou un statut fourni par le navigateur ne suffit pas.

À l'application, une annulation confirmée suspend d'abord les traitements V3. Si un BC est associé, le mécanisme existant contrôle les documents Erplain, annule les BL admissibles puis le BC et relit leur statut. Après confirmation, V3 affiche la commande annulée. Sans BC, l'annulation est uniquement locale.

Les commandes expédiées, facturées, avec des documents partagés ou un mouvement de stock à rapprocher ne sont pas annulées dans Erplain. Elles restent suspendues et leur motif apparaît dans le bilan « à vérifier ». Les étiquettes et documents historiques restent conservés. Aucun remboursement ni annulation de transporteur n'est effectué.

Un résultat Erplain incertain est uniquement vérifié lors d'un nouveau passage : aucune mutation d'annulation n'est répétée. En cas d'interruption de la connexion, relancer le bouton pour recommencer le parcours. Garder la page ouverte pendant le contrôle.

Accès : opérateur, responsable ou administrateur. Chaque résultat est enregistré dans l'audit, avec l'utilisateur ; la preuve source est conservée dans `source_payload.manualPlatformCancellation`.

Validation locale : `node --test test/manual-platform-cancellation.test.mjs test/order-suspension-experience.test.mjs`.
