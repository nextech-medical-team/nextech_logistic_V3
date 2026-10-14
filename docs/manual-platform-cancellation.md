# Actualisation manuelle des annulations

Dans « Toutes les commandes », cliquer sur « Actualiser les annulations Temu / Shopify ». Le module parcourt toutes les commandes V3 non archivées de ces deux canaux, indépendamment des filtres affichés. Il n'importe pas de nouvelles commandes et ne démarre aucun contrôle périodique.

Chaque commande est relue directement sur sa plateforme. Shopify doit confirmer une date d'annulation ; un remboursement seul ne déclenche rien. Temu doit confirmer le statut 3 et la référence exacte sur la boutique identifiée de la commande.

Une annulation confirmée suspend d'abord les traitements V3. Si un BC est associé, le mécanisme existant contrôle les documents Erplain, annule les BL admissibles puis le BC et relit leur statut. Après confirmation, V3 affiche la commande annulée. Sans BC, l'annulation est uniquement locale.

Les commandes expédiées, facturées, avec des documents partagés ou un mouvement de stock à rapprocher ne sont pas annulées dans Erplain. Elles restent suspendues et leur motif apparaît dans le bilan « à vérifier ». Les étiquettes et documents historiques restent conservés. Aucun remboursement ni annulation de transporteur n'est effectué.

Un résultat Erplain incertain est uniquement vérifié lors d'un nouveau passage : aucune mutation d'annulation n'est répétée. En cas d'interruption de la connexion, relancer le bouton pour recommencer le parcours. Garder la page ouverte pendant le contrôle.

Accès : opérateur, responsable ou administrateur. Chaque résultat est enregistré dans l'audit, avec l'utilisateur ; la preuve source est conservée dans `source_payload.manualPlatformCancellation`.

Validation locale : `node --test test/manual-platform-cancellation.test.mjs test/order-suspension-experience.test.mjs`.
