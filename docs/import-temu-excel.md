# Import Excel TEMU multi-pays

Dans **Paramètres → Imports de fichiers**, choisir **Commandes TEMU · Excel multi-pays**.
Sélectionner un seul Excel ou plusieurs exports, puis **Analyser les fichiers**. Un lot accepte jusqu’à 50 fichiers et 12 Mo cumulés. Pour un lot plus volumineux, faire plusieurs imports ; les doublons sont revérifiés à chaque confirmation.

Le lecteur détecte les en-têtes dans les 30 premières lignes du rapport, ignore la feuille des transporteurs et reconnaît le pays dans la colonne du fichier, indépendamment de son nom. Les exports fournis France, Italie, Pays-Bas et Espagne utilisent les mêmes en-têtes français ; les principaux en-têtes anglais sont également reconnus. Un autre format ou une colonne obligatoire absente est signalé dans l’aperçu.

Les lignes sont regroupées par `Order ID`, avec la référence vendeur **contribution SKU** et le numéro de ligne TEMU. Le SKU TEMU est conservé séparément. Les codes postaux français et italiens conservent leurs cinq chiffres, y compris les zéros initiaux. Les dates sont converties en UTC à partir du décalage explicite de l’export. Les valeurs financières et autres colonnes sources sont conservées par ligne ; elles ne sont pas converties en documents Erplain par cet import.

L’aperçu affiche les totaux par pays, les fichiers, les erreurs et toutes les commandes par pages de 100. Seules les nouvelles commandes valides sont sélectionnables. Les commandes déjà présentes, y compris archivées, ne sont jamais écrasées ou copiées. Une ligne répétée identique est ignorée ; une contradiction de ligne, d’adresse, de date ou de pays bloque la commande entière. Une ligne dont la référence est illisible bloque le fichier concerné. Les autres fichiers valides restent importables.

Cette première version accepte uniquement les commandes et articles **non expédiés**, avec quantité à expédier égale à la quantité achetée, sans quantité déjà expédiée ou annulée. Les formules, adresses masquées et données obligatoires manquantes sont signalées avant confirmation.

**Importer et préparer les commandes sélectionnées** réanalyse les fichiers, vérifie leur empreinte et les doublons apparus depuis l’aperçu, puis enregistre le lot dans une transaction. Un identifiant de validation empêche une double soumission de recréer des commandes. Le rapport texte peut être téléchargé après analyse et après import.

Les commandes sont créées avec une suspension active et la note **Import Excel TEMU : vérifier la commande et sa boutique avant toute préparation**. Aucun travail de préparation, aucune étiquette et aucun BC/BL n’est créé par cet import. L’Excel ne prouve pas la boutique API : aucune identité de boutique n’est inventée. La confirmation de l’aperçu demande ensuite la préparation Erplain depuis les données Excel, sans accès TEMU. Le panneau **Préparer les commandes Excel TEMU** reste disponible pour reprendre les imports antérieurs ou interrompus.

Les routes `POST /api/import/temu/preview` et `POST /api/import/temu/confirm` sont réservées aux administrateurs, managers et opérateurs. Les contrôles existants de session, de préparation et de suspension restent applicables. Les exports clients locaux `order_export-*.xlsx` sont exclus de Git ; les tests utilisent des données fictives.

Validation : `npm run test:temu-import`, `npm run check` et `npx playwright test test/ui/temu-excel-import.spec.mjs`.

## Préparation dans l’application principale

Dans l’aperçu du fichier, les nouvelles commandes valides sont cochées par défaut. Cliquer **Importer et préparer les commandes sélectionnées**. Les BC/BL sont préparés depuis les données Excel et le mapping Erplain, sans connexion TEMU. La recherche de boutique est reportée au parcours d’étiquette. Cette confirmation est réservée aux administrateurs et managers, comme les reprises Erplain existantes.

L’interface enregistre le lot puis vérifie et prépare chaque nouvelle commande sélectionnée, avec affichage de l’avancement. Les doublons ne sont jamais préparés par ce bouton. Les erreurs sont conservées par commande ; **Reprendre les préparations restantes** réessaie uniquement les échecs, sans réimporter le lot ni recréer une demande déjà acceptée. Si la page est fermée avant la fin, les commandes enregistrées restent accessibles dans **Préparer les commandes Excel TEMU** pour reprendre leur validation.

La validation des BC/BL conserve les contrôles de suspension, de préparation existante et d’empreinte des données. Une double validation renvoie la même préparation. Avant l’étiquette, le connecteur recherche la boutique par la commande dans tous les accès configurés, puis vérifie l’état TEMU et les expéditions existantes. Un refus TEMU bloque l’étiquette, sans empêcher la demande de BC/BL depuis l’Excel. Pendant la recherche multi-boutiques, la réponse `140020002` accompagnée de `Order not found` signifie que la recherche doit continuer dans les autres boutiques. Une correspondance unique reste obligatoire ; les erreurs réseau, quotas et refus d’autorisation restent bloquants.

La validation enregistre une action `resume` dans la file de résolutions existante. Ce worker applique le mapping habituel, puis appelle le worker Erplain LIVE existant pour créer, relire et vérifier les BC/BL et le stock. Les références Erplain, les doublons, les créations incertaines et les contrôles de publication suivent ce même parcours. Une correspondance SKU ou une quantité à corriger reste visible dans **Voir la commande / corriger** ; aucun mapping n’est deviné.

Les prix utilisent `buildBcPricing`, partagé avec Amazon : la colonne **Total du prix de base après réduction** fournit le montant vendeur par ligne, auquel sont ajoutées la livraison et les taxes du rapport. Le prix de vente et le total payé par le client ne servent pas de remplacement ; une base vendeur absente bloque la préparation. La quantité préparée issue du mapping ne multiplie pas à nouveau ces totaux. Une empreinte des articles et montants Excel est enregistrée et revérifiée avant la préparation. Les montants API ne remplacent pas les montants Excel pour le BC.

Après validation du BL et du stock, **Étiquette et marge TEMU** ouvre l’écran TEMU existant. Afficher le tarif, vérifier la marge puis confirmer l’achat. Le moteur commun conserve ses protections contre les doubles achats et récupère le PDF et le suivi. Pour ces commandes Excel, le poids déclaré est **0,25 kg**, les dimensions **10 × 8 × 0,5 cm**, et le dernier créneau admissible de l’offre est retenu selon la limite TEMU. Les dimensions restent soumises à l’acceptation de l’API. Le devis est lié à la préparation ; une modification impose de le refaire.

L’achat automatique est activé pour les commandes Excel raccordées lorsque les contrôles existants passent et que la marge est strictement positive. Le calcul de marge reste celui de `/api/margins`, alimenté par les colonnes vendeur Excel, les coûts du référentiel publié et le devis ou coût réel TEMU. Un référentiel absent ou un mapping incompatible donne une marge indisponible ou incomplète.

Les routes de raccordement sont `GET /api/temu/excel/orders`, `GET /api/temu/excel/preview` et `POST /api/temu/excel/prepare`. Les contrôles d’accès et de session du serveur principal s’appliquent. Aucun nouvel achat ni document réel n’est effectué par les tests : `node --test test/temu-excel-production.test.mjs` et `npx playwright test test/ui/temu-excel-production.spec.mjs`.

## Essai manuel local

Lancer `npm run test:temu-local`, puis ouvrir `http://127.0.0.1:31235`. Le serveur ouvre directement l’import TEMU et conserve sa base PGlite sous `data/temu-excel-local/db`. Les BC/BL de test utilisent `.env.erplain-test`. Les outils de comparaison lisent les accès PROD de `.env` uniquement lors de leur utilisation, sans modifier Erplain. Les commandes importées sont visibles dans le tableau local. Réimporter le même fichier permet de vérifier les doublons. Les fichiers Excel restent intacts. Les imports de l’ancien serveur en mémoire doivent être refaits une fois.

### BC et BL dans Erplain TEST uniquement

Configurer `ERPLAIN_TEST_API_KEY` dans `.env.erplain-test` (ignoré par Git), puis ouvrir le lien **Tester les BC et BL** dans le bandeau local, ou `/erplain-test`. Cocher une à cinq commandes importées. Vérifier le SKU logistique Erplain et sa quantité, notamment pour les lots TEMU. Le bouton cherche un client existant de même type, nom et adresse complète avant toute création. Un homonyme ou plusieurs correspondances bloquent la préparation. Un nouveau client reçoit les noms, coordonnées et adresse ; le type est Individuel, sauf présence explicite d’un nom de société dans les colonnes source. Le BC utilise le prix de base vendeur après réduction, la livraison et les taxes de l’Excel pour reprendre le règlement estimé vendeur. Les remises ne sont pas retranchées deux fois. Les montants manquants, devises contradictoires, remboursements et totaux incohérents bloquent le traitement. Le calcul et les contrôles de lignes utilisent `buildBcPricing` et `verifyBcPricing`, partagés avec Amazon, puis les prix sont exprimés TTC pour conserver les centimes source. Les montants Excel et relus dans Erplain sont affichés. Le BL est publié en attente (`pending`) après vérification du stock (`assertFullOrderStock`) et de son lien au BC ; il apparaît alors dans les BL de la commande. Les anciens documents de ce test à zéro sont complétés sur place, après contrôle de leur référence et de leurs quantités. Aucun email, facture, étiquette ni mouvement de stock supplémentaire n’est demandé.

Le connecteur utilise uniquement l’endpoint officiel et vérifie l’identité **101406** avant chaque mutation ; toute autre société, notamment **100174**, est refusée. Aucun connecteur de production n’est modifié. Les routes de création sont exposées uniquement par le serveur loopback de test et exigent l’origine locale. Les BC/BL et résultats incertains sont conservés sous `data/temu-excel-local/documents` pour empêcher une seconde création après rechargement ou redémarrage. Un résultat de mutation incertain ou un verrou laissé par un arrêt brutal requiert un rapprochement manuel avec Erplain avant reprise : ne pas supprimer ces fichiers pour relancer.

Ce parcours local reste isolé. Le parcours de production ci-dessus utilise les workers Erplain existants et la base de l’application principale.

Vérification ciblée : `node --test test/temu-erplain-test.test.mjs test/temu-excel-commercial.test.mjs test/temu-excel-import.test.mjs`.

### Liaison au tableau local et étiquette de simulation

Les identifiants BC/BL TEST sont sauvegardés dans `orders.erp_test` et rapprochés avec le journal persistant au démarrage. Le tableau local affiche explicitement ces documents TEST, sans les stocker dans `erp_live`. Le lien `/?view=orders` ouvre directement ce tableau. Les contrôles de production y sont masqués et leurs routes restent inactives.

Après confirmation des BC et BL, le bouton **Créer l’étiquette TEST** génère un PDF local marqué **TEST — NE PAS EXPÉDIER**, reprenant la référence, le destinataire, les BC/BL et les SKU/quantités préparés. Il est conservé sous `data/temu-excel-local/labels` et téléchargeable sur la commande. C’est une simulation documentaire, sans achat, réservation ni suivi transporteur. La génération est refusée pour les documents incomplets, incertains, ou hors société 101406. La même commande et les mêmes documents réutilisent le même PDF. Aucun statut logistique réel ni stock supplémentaire n’est modifié.

### Achat réel d’étiquettes TEMU après les BC/BL TEST

Dans le tableau local (`/?view=orders`), **Acheter l’étiquette TEMU** apparaît après validation des BC et BL TEST. Choisir la boutique, puis **Afficher le tarif**. Le bouton **Confirmer l’achat réel** affiche le prix et déclenche l’achat via l’API TEMU. Les BC/BL restent dans Erplain TEST ; l’étiquette TEMU est réelle et payante. L’ancienne route de simulation reste disponible, mais le tableau affiche désormais les actions TEMU réelles.

Ce parcours fixe le poids déclaré à **0,25 kg** et reprend le petit format existant **10 × 8 × 0,5 cm**. Ces dimensions ne constituent pas une garantie du minimum autorisé par chaque transporteur : l’API doit accepter le devis. Il choisit l’offre admissible la moins chère selon la politique TEMU existante, puis le dernier créneau de cette offre qui précède la limite d’expédition. Sans créneau, il conserve l’expédition différée du connecteur (120 h, ou 360 h pour une précommande).

Les connexions réutilisent `data/temu-production.json` (ou `DATA_DIR`) et le coffre de boutiques existant, sans exposer les secrets au navigateur. Un relais configuré en lecture seule continue de refuser les achats. Aucune connexion TEMU n’est lancée à l’import Excel ou au chargement du tableau ; elle commence à l’ouverture du dialogue d’étiquette.

Le numéro de commande, les numéros de lignes et les quantités sont comparés avec l’API. Les documents TEST sont liés au devis : les modifier impose de refaire le devis. La suspension d’import est conservée dans la base locale ; elle est remplacée uniquement pour cette action par le contrôle explicite des BC/BL TEST, sans lever une autre suspension. Les achats et PDF sont persistés dans la base locale, séparée de la production. Après un achat incertain ou une expédition existante, utiliser **Récupérer l’étiquette TEMU**, sans refaire l’achat. Le PDF et le numéro de suivi sont affichés dans le tableau.

Validation sans achat réel : `node --test test/temu-excel-labels.test.mjs test/temu-purchase-policy.test.mjs test/temu-local-label.test.mjs test/temu-read-deferral.test.mjs` et `npx playwright test test/ui/temu-excel-labels.spec.mjs`.

Le parcours Excel utilise les mêmes fonctions `temuShipping.prepare`, `temuShipping.buy` et `temuShipping.recover` (`src/temu-shipping.mjs`) que le parcours d’import API, ainsi que `temuApi` pour les appels et les PDF. La connexion aux boutiques est commune via `connectTemuShops` (`src/temu-shop-clients.mjs`), extraite du connecteur existant sans changer sa politique de sélection des accès. Le module Excel ajoute le contrôle des lignes importées et des BC/BL TEST ; il ne réimplémente ni le devis, ni l’achat, ni la récupération TEMU. Un test comparatif vérifie l’égalité des requêtes d’achat et des PDF entre les deux parcours.

### Marge des commandes Excel

Le dialogue d’achat affiche la marge après **Afficher le tarif**. Il appelle `createMarginsService`, le calculateur existant du parcours API : recettes vendeur et contribution HT issues des colonnes Excel, achats et transport fournisseur issus du référentiel publié, puis coût du devis TEMU converti en HT selon la règle existante. Après achat, le calculateur prend le coût d’étiquette retourné par TEMU. Les réductions et contributions ne sont pas comptées deux fois. Les SKU et quantités préparés dans le BC TEST sont comparés au mapping du calculateur ; une différence donne une marge incomplète.

Le détail de marge du tableau utilise également ce service via `/api/margins`. Le fichier privé `src/margin-published-snapshot.json` est nécessaire pour disposer des coûts réels du référentiel. Il est exclu du dépôt : en son absence, le dialogue indique **Marge indisponible**, et le détail retourne une erreur explicite. Aucun coût n’est inventé et une marge incomplète n’est pas présentée comme nulle. Dans le serveur local de test, l’achat reste soumis à confirmation manuelle. Dans l’application principale, le worker API existant traite les marges positives ; les autres achats restent manuels.

Vérification : `node --test test/temu-excel-margins.test.mjs test/temu-excel-labels.test.mjs`. Les tests comparent les résultats des sources API et Excel à montants vendeur identiques, vérifient le coût du devis puis de l’étiquette, et couvrent les coûts absents et les mappings différents. Les données de test sont fictives.

### Périmètre de publication

Le serveur principal expose l’import Excel et son aperçu authentifié. Les commandes importées restent suspendues pour validation ; leur import ne déclenche aucune préparation automatique.

Les pages `/status-preview` et `/erplain-test`, ainsi que les routes `/api/local-*`, appartiennent exclusivement au serveur local `npm run test:temu-local`, lié à `127.0.0.1`. Elles ne sont pas exposées par `npm start`. Le parcours de production utilise les routes `/api/temu/prepare`, `/api/temu/buy` et `/api/temu/recover` habituelles ; les outils locaux restent séparés.

La comparaison locale réutilise les règles du moteur de synchronisation, mais ne modifie ni les statuts Nextech ni Erplain. Les suivis GLS/GOFO sont saisis par l’utilisateur ; leur appartenance et leur exhaustivité doivent être vérifiées. Le service principal utilise les colis enregistrés dans Nextech. Publier cette branche n’active pas les écritures Erplain : les contrôles existants `ERPLAIN_LIVE_WRITES`, `MIGRATION_PREPARATION` et l’exclusion du traitement concurrent `lifecycle` restent applicables.

Les exports clients, bases locales, accès API et référentiels privés restent exclus du dépôt.


## Achat après préparation Excel

Le worker existant `temuAutomaticPurchaseWorker` traite aussi les commandes Excel raccordées. Il lève uniquement l’attente issue de leur préparation terminée, relit Erplain, valide le BL et le stock, obtient le devis TEMU et recalcule la marge avec ce devis. La marge doit être strictement positive et le transporteur admissible selon la politique API existante (Cainiao exclu). L’achat conserve la protection contre les doublons et son audit.

Une marge nulle, négative ou inconnue ne déclenche aucun achat automatique. Le bouton **Acheter l’étiquette**, dans la ligne de commande dont le BL et le stock sont validés, ouvre directement le dialogue existant avec le prix et la confirmation manuelle. Les contrôles serveur restent appliqués. Ce comportement remplace la règle antérieure d’achat exclusivement manuel pour les imports Excel.

### Fiche client TEMU en production

La création transmet le prénom et le nom du rapport Excel (ou, à défaut, sépare le nom complet reçu), les coordonnées disponibles et deux adresses par défaut, facturation et livraison. Le numéro est obtenu par `GenerateCustomerNumber` dans Erplain puis conservé dans `erp_live.customerNumber` avant la création. Les clients sont créés successivement pour ne pas demander plusieurs fois le même prochain numéro. La reprise après interruption recherche ce numéro ; les anciennes fiches `V3:…` restent reconnues. Ces changements concernent les nouvelles créations et ne modifient pas les fiches déjà enregistrées.

Les nouveaux BC TEMU (Excel et API) conservent le règlement vendeur TTC. Selon la règle demandée, le taux standard du pays de livraison s’applique aux produits et à la livraison, indépendamment de la taxe de la fiche produit et de celle du rapport. Le code sélectionne la taxe active correspondante dans Erplain. Une taxe absente ou ambiguë, ou un pays non couvert, bloque la création sans taux de secours. Les BC existants ne sont pas réécrits. Le calcul de marge utilise également les montants HT recalculés au taux du pays.

Taux vérifiés le 14 octobre 2026 : AT 20, BE 21, BG 20, CY 19, CZ 21, DE 19, DK 25, EE 24, GR 24, ES 21, FI 25,5, FR 20, HR 25, HU 27, IE 23, IT 22, LT 21, LU 17, LV 21, MT 18, NL 21, PL 23, PT 23, RO 21, SE 25, SI 22, SK 23, GB 20, CH 8,1, NO 25 (%). Ce tableau implémente la règle standard demandée, sans détermination des taux réduits par produit ni des régimes territoriaux particuliers.

Sources : [Union européenne](https://europa.eu/youreurope/business/finance-and-tax/vat/vat-rules-rates/index_en.htm), [Royaume-Uni](https://www.gov.uk/vat-rates), [Suisse](https://www.estv.admin.ch/en/vat-rates-switzerland), [Norvège](https://www.skatteetaten.no/satser/merverdiavgift/).
