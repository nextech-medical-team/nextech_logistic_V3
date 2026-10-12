# Import des commandes Shopify

Dans **Paramètres → Import Shopify · Excel**, choisir le fichier, analyser les commandes, puis valider la sélection. Cet écran est distinct des autres imports.

Le menu et l’analyse sont accessibles aux administrateurs, managers et opérateurs avec ou sans `MIGRATION_PREPARATION=1`. Ce mode suspend seulement la validation des commandes ; il ne masque pas l’écran Shopify.

Formats acceptés : `.xlsx` et `.csv` (export standard des commandes Shopify). Pour Excel, conserver les en-têtes de l’export et utiliser la première feuille, avec des valeurs sans formules.

Colonnes obligatoires : `Name` (référence, par exemple `#1001`), `Id` (identifiant Shopify), `Lineitem sku`, `Lineitem quantity`. Une ligne par article ; les lignes suivantes d’une commande peuvent répéter `Name` ou le laisser vide.

Colonnes de livraison : `Shipping Name`, `Shipping Address1` (ou `Shipping Street`), `Shipping Address2`, `Shipping Zip`, `Shipping City`, `Shipping Country`, `Shipping Phone`. `Created at`, `Shipping Method` et `Cancelled at` sont également lus.

L’aperçu détecte les références déjà présentes sur le canal Shopify. Les nouvelles commandes sont sélectionnées par défaut ; créer une copie d’une commande existante utilise la confirmation habituelle. Une ligne sans SKU ou avec une quantité invalide bloque la commande entière pour correction.

Les lignes encapsulées dans un champ CSV sont décodées lorsque leurs colonnes correspondent à l’en-tête. L’apostrophe Excel devant un code postal est retirée.

Un classeur Excel contenant le texte CSV dans la seule colonne A est également accepté : l’en-tête et chaque ligne sont décodés avant la lecture des commandes. Les champs contenant des virgules entre guillemets sont conservés.

Le CSV ne fournit pas les identifiants des articles, les ventilations complètes des remises et taxes ni les métadonnées de relais. La connexion Shopify existante (`shopify-readonly.json`) relit donc la commande par `Id`, lors de l’aperçu et de la validation. La référence, la devise, les SKU et les quantités doivent correspondre au fichier. Sans configuration API, l’import utilise les données du fichier. Les prix détaillés et les informations de relais manquants restent soumis aux contrôles habituels de préparation. Si la relecture API constate des données modifiées, la fiche reste à corriger.

Les données relues passent par `normalizeShopifyOrders`, comme les commandes reçues par API : adresse, vrais identifiants des articles, prix, taxes, remises et livraison. Les statuts d’expédition restent indicatifs selon la politique existante ; annulations et remboursements complets utilisent les protections Shopify existantes.

L’import respecte les restrictions existantes de préparation LIVE. Il ne contourne pas les contrôles de livraison en relais : l’export doit être complété par les informations de relais requises avant création d’étiquette.

Structure de référence : [export des commandes Shopify](https://help.shopify.com/en/manual/fulfillment/managing-orders/exporting-orders).
