# Vérification des commandes manquantes

Dans **Paramètres → Vérification des commandes**, sélectionner **Shopify** ou **TEMU — tous pays**, choisir une date et une heure limites (24 heures dans le passé par défaut), puis cliquer sur **Lancer la vérification**. Seule la plateforme sélectionnée est consultée.

Le module affiche exclusivement les commandes créées dans cette période, créées strictement avant la date et l’heure choisies et absentes des références ou références source V3 pour la plateforme correspondante. Les commandes archivées comptent comme présentes. Tous les statuts source sont inclus, y compris les annulations.

La lecture utilise la boutique Shopify configurée dans `shopify-readonly.json` et toutes les boutiques TEMU accessibles via la connexion principale, ses jetons associés et le coffre des boutiques. Aucun filtre de pays n'est appliqué. L'historique réellement accessible dépend des droits API et des boutiques connectées. Le client TEMU existant utilise le point d'accès européen : cette fonction n'ajoute pas de connexion à d'autres régions API.

La pagination est lue à la demande par étapes. Une boutique inaccessible ou une pagination incohérente produit une mention **Vérification incomplète**, tout en laissant les autres boutiques être consultées. Les résultats sont revérifiés contre V3 pendant la lecture pour tenir compte des imports concurrents. Ils décrivent la présence au moment de cette vérification et ne sont pas actualisés automatiquement après sa fin.

Accès administrateur ou manager. Les rapports sont temporaires, gardés en mémoire pendant une heure après la dernière lecture. Ce module ne crée ni commande, ni réception, ni traitement V3, et n'effectue aucune modification sur les plateformes.

Validation : `node --test test/missing-orders-verification.test.mjs`.

Le calendrier permet de choisir une date et une heure locales, au moins 24 heures dans le passé et dans les 60 derniers jours. Le tableau affiche les commandes créées avant cet instant et leur statut source (annulations Shopify incluses). Les codes TEMU restent visibles ; le code 3 est signalé comme annulé.
