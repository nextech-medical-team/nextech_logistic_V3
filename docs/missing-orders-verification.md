# Vérification des commandes manquantes

Dans **Paramètres → Vérification des commandes**, choisir une période (28 jours par défaut, 2 à 60 jours) puis cliquer sur **Vérifier Shopify et TEMU**.

Le module affiche exclusivement les commandes créées dans cette période, âgées de strictement plus de 24 heures et absentes des références ou références source V3 pour la plateforme correspondante. Les commandes archivées comptent comme présentes. Tous les statuts source sont inclus, y compris les annulations.

La lecture utilise la boutique Shopify configurée dans `shopify-readonly.json` et toutes les boutiques TEMU accessibles via la connexion principale, ses jetons associés et le coffre des boutiques. Aucun filtre de pays n'est appliqué. L'historique réellement accessible dépend des droits API et des boutiques connectées. Le client TEMU existant utilise le point d'accès européen : cette fonction n'ajoute pas de connexion à d'autres régions API.

La pagination est lue à la demande par étapes. Une boutique inaccessible ou une pagination incohérente produit une mention **Vérification incomplète**, tout en laissant les autres boutiques être consultées. Les résultats sont revérifiés contre V3 pendant la lecture pour tenir compte des imports concurrents. Ils décrivent la présence au moment de cette vérification et ne sont pas actualisés automatiquement après sa fin.

Accès administrateur ou manager. Les rapports sont temporaires, gardés en mémoire pendant une heure après la dernière lecture. Ce module ne crée ni commande, ni réception, ni traitement V3, et n'effectue aucune modification sur les plateformes.

Validation : `node --test test/missing-orders-verification.test.mjs`.
