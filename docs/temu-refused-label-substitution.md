# Remplacement après refus d’adresse TEMU

Une réponse TEMU `shipment_error` pour `shipping address contains non-English characters` autorise la vérification puis la confirmation d’un remplacement dans le BC, sans exiger un PDF inexistant. Ce cas est limité à un colis unique dont toutes les lignes et quantités correspondent à la commande. Un suivi, un document, une expédition confirmée ou une répartition ambiguë maintiennent le blocage.

Après actualisation TEMU, une demande auparavant bloquée peut recevoir un nouvel aperçu. Les quantités sont conservées ; la confirmation précédente est supprimée et l’opérateur confirme le nouvel aperçu après contrôle du stock et du poids.

Après remplacement, la préparation reste suspendue. Le colis TEMU, sa tentative d’achat et son refus restent enregistrés : aucune suppression, aucun rachat automatique, aucune création de BL dans cette reprise. Corriger les coordonnées exactes dans TEMU, vérifier les possibilités de reprise du colis existant, puis actualiser et rapprocher son état avant de reprendre la préparation. V3 ne transforme pas automatiquement l’adresse du destinataire.

Tests : `node --test test/temu-substitution-recovery.test.mjs test/equivalence-import-substitution.test.mjs test/temu-shipment-remediation.test.mjs test/temu-purchase-policy.test.mjs`.
