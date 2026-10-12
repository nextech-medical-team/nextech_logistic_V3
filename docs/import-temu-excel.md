# Import Excel TEMU multi-pays

Dans **Paramètres → Imports de fichiers**, choisir **Commandes TEMU · Excel multi-pays**.
Sélectionner un seul Excel ou plusieurs exports, puis **Analyser les fichiers**. Un lot accepte jusqu’à 50 fichiers et 12 Mo cumulés. Pour un lot plus volumineux, faire plusieurs imports ; les doublons sont revérifiés à chaque confirmation.

Le lecteur détecte les en-têtes dans les 30 premières lignes du rapport, ignore la feuille des transporteurs et reconnaît le pays dans la colonne du fichier, indépendamment de son nom. Les exports fournis France, Italie, Pays-Bas et Espagne utilisent les mêmes en-têtes français ; les principaux en-têtes anglais sont également reconnus. Un autre format ou une colonne obligatoire absente est signalé dans l’aperçu.

Les lignes sont regroupées par `Order ID`, avec la référence vendeur **contribution SKU** et le numéro de ligne TEMU. Le SKU TEMU est conservé séparément. Les codes postaux français et italiens conservent leurs cinq chiffres, y compris les zéros initiaux. Les dates sont converties en UTC à partir du décalage explicite de l’export. Les valeurs financières et autres colonnes sources sont conservées par ligne ; elles ne sont pas converties en documents Erplain par cet import.

L’aperçu affiche les totaux par pays, les fichiers, les erreurs et toutes les commandes par pages de 100. Seules les nouvelles commandes valides sont sélectionnables. Les commandes déjà présentes, y compris archivées, ne sont jamais écrasées ou copiées. Une ligne répétée identique est ignorée ; une contradiction de ligne, d’adresse, de date ou de pays bloque la commande entière. Une ligne dont la référence est illisible bloque le fichier concerné. Les autres fichiers valides restent importables.

Cette première version accepte uniquement les commandes et articles **non expédiés**, avec quantité à expédier égale à la quantité achetée, sans quantité déjà expédiée ou annulée. Les formules, adresses masquées et données obligatoires manquantes sont signalées avant confirmation.

**Importer les commandes sélectionnées** réanalyse les fichiers, vérifie leur empreinte et les doublons apparus depuis l’aperçu, puis enregistre le lot dans une transaction. Un identifiant de validation empêche une double soumission de recréer des commandes. Le rapport texte peut être téléchargé après analyse et après import.

Les commandes sont créées avec une suspension active et la note **Import Excel TEMU : vérifier la commande et sa boutique avant toute préparation**. Aucun travail de préparation, aucune étiquette et aucun BC/BL n’est créé par cet import. L’Excel ne prouve pas la boutique API : aucune identité de boutique n’est inventée. Vérifier les données et le rattachement TEMU avant toute réactivation par les contrôles existants.

Les routes `POST /api/import/temu/preview` et `POST /api/import/temu/confirm` sont réservées aux administrateurs, managers et opérateurs. Les contrôles existants de session, de préparation et de suspension restent applicables. Les exports clients locaux `order_export-*.xlsx` sont exclus de Git ; les tests utilisent des données fictives.

Validation : `npm run test:temu-import`, `npm run check` et `npx playwright test test/ui/temu-excel-import.spec.mjs`.

## Essai manuel local

Lancer `npm run test:temu-local`, puis ouvrir `http://127.0.0.1:31235`. Le serveur ouvre directement l’import TEMU et conserve sa base PGlite sous `data/temu-excel-local/db`. Il ne charge pas le `.env` de production. Les commandes importées sont visibles dans le tableau local. Réimporter le même fichier permet de vérifier les doublons. Les fichiers Excel restent intacts. Les imports de l’ancien serveur en mémoire doivent être refaits une fois.

### BC et BL dans Erplain TEST uniquement

Configurer `ERPLAIN_TEST_API_KEY` dans `.env.erplain-test` (ignoré par Git), puis ouvrir le lien **Tester les BC et BL** dans le bandeau local, ou `/erplain-test`. Cocher une à cinq commandes importées. Vérifier le SKU logistique Erplain et sa quantité, notamment pour les lots TEMU. Le bouton cherche un client existant de même type, nom et adresse complète avant toute création. Un homonyme ou plusieurs correspondances bloquent la préparation. Un nouveau client reçoit les noms, coordonnées et adresse ; le type est Individuel, sauf présence explicite d’un nom de société dans les colonnes source. Le BC utilise les prix de vente client après réductions, livraison et TVA de l’Excel. Les remises ne sont pas retranchées deux fois. Les montants manquants, devises contradictoires, remboursements et totaux incohérents bloquent le traitement. Le calcul et les contrôles de lignes utilisent `buildBcPricing` et `verifyBcPricing`, partagés avec Amazon, puis les prix sont exprimés TTC pour conserver les centimes source. Les montants Excel et relus dans Erplain sont affichés. Le BL est publié en attente (`pending`) après vérification du stock (`assertFullOrderStock`) et de son lien au BC ; il apparaît alors dans les BL de la commande. Les anciens documents de ce test à zéro sont complétés sur place, après contrôle de leur référence et de leurs quantités. Aucun email, facture, étiquette ni mouvement de stock supplémentaire n’est demandé.

Le connecteur utilise uniquement l’endpoint officiel et vérifie l’identité **101406** avant chaque mutation ; toute autre société, notamment **100174**, est refusée. Aucun connecteur de production n’est modifié. Les routes de création sont exposées uniquement par le serveur loopback de test et exigent l’origine locale. Les BC/BL et résultats incertains sont conservés sous `data/temu-excel-local/documents` pour empêcher une seconde création après rechargement ou redémarrage. Un résultat de mutation incertain ou un verrou laissé par un arrêt brutal requiert un rapprochement manuel avec Erplain avant reprise : ne pas supprimer ces fichiers pour relancer.

Ce parcours local ne constitue pas l’intégration automatique TEMU au workflow Amazon de production. L’import de production reste en attente de validation ; la préparation commerciale doit être raccordée et validée séparément.

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

Le détail de marge du tableau utilise également ce service via `/api/margins`. Le fichier privé `src/margin-published-snapshot.json` est nécessaire pour disposer des coûts réels du référentiel. Il est exclu du dépôt : en son absence, le dialogue indique **Marge indisponible**, et le détail retourne une erreur explicite. Aucun coût n’est inventé et une marge incomplète n’est pas présentée comme nulle. L’achat reste une confirmation manuelle, comme le bouton API existant ; ce raccordement n’active pas l’achat automatique sur marge positive.

Vérification : `node --test test/temu-excel-margins.test.mjs test/temu-excel-labels.test.mjs`. Les tests comparent les résultats des sources API et Excel à montants vendeur identiques, vérifient le coût du devis puis de l’étiquette, et couvrent les coûts absents et les mappings différents. Les données de test sont fictives.
