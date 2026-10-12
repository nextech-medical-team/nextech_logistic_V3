# NEXTECH LOGISTIC V3

Sources Node.js24 de l'application. `npm ci --ignore-scripts`, `npm run check` et `npm test` exécutent les contrôles isolés. Données, documents, étiquettes, coffres et identifiants de production sont exclus du dépôt.

Après initialisation de l'exécuteur Section7, chaque push sur `main` déclenche tests puis publication automatique, sous contrôle de la file commune et du verrou serveur. Configuration et retour arrière : [deploy/README.md](deploy/README.md).

La copie publique contient des sources épurées. Ne jamais écraser une différence privée ni les développements serveur concurrents. Ne pas connecter le développement aux services métier réels sans autorisation spécifique.
Les bases de données, documents, étiquettes, journaux et identifiants de production sont volontairement exclus. Ne jamais connecter un environnement de développement aux services métier réels sans autorisation spécifique.

L'export initial du serveur ne contenait pas les dossiers `scripts/` et `test/`. Ils ont depuis été ajoutés : `npm run check` vérifie la syntaxe JavaScript, `npm test` vérifie les filtres de problèmes et les contrôles de publication, et `npm run test:tracking` vérifie la synchronisation et l'export Excel après installation des dépendances. Ces tests isolés ne valident pas les connexions de production.

Après activation CI/CD, chaque push main est publié par l’exécuteur Section7 : tests, file commune, preuves et verrou serveur restent obligatoires.

Les instantanés métier margin-published-snapshot.json et temu-reading-reports.json sont exclus. Le périmètre privé de réimport TEMU est vide dans cette copie : aucun réimport de ce lot ne peut être autorisé par cette copie. Le service de marges nécessite son fichier de configuration privé pour démarrer. Ces exclusions concernent seulement le dépôt public ; le serveur reste inchangé.
Les identifiants privés du lot cancelled-import-reimport sont aussi retirés ; ce lot reste désactivé dans la copie publique.

## Reprise d'un remplacement après récupération TEMU

La fenêtre de remplacement récupère les SKU et quantités selon le mapping actuel. Une équivalence enregistrée pour cette commande conserve ses quantités propres ; un ancien cache de préparation ne remplace pas une conversion plus récente.

Les quantités sont exprimées en unités du SKU logistique Erplain. Après confirmation et vérification de la mise à jour du BC, V3 synchronise ses lignes locales et affiche `ancien SKU (quantité remplacée) → nouveau SKU (quantité équivalente)` dans la colonne SKU (quantité). Cette indication repose uniquement sur les remplacements enregistrés avec succès. Les commandes sans remplacement gardent l'affichage habituel. Les lignes déjà remplacées ne sont pas reconverties par un autre mapping.

Après récupération automatique d'un achat TEMU, V3 relance la vérification d'un remplacement bloqué uniquement par « Achat TEMU en cours, incertain ou multi-colis » si un seul colis couvre toute la commande et si son PDF est disponible. Les SKU et quantités proposés sont conservés, puis vérifiés contre le BC et le stock actuels. Le résultat demande une nouvelle confirmation du remplacement. Aucun nouvel achat d'étiquette n'est effectué par cette reprise. Les achats incertains, les répartitions multi-colis, les commandes expédiées ou suspendues et les écritures déjà commencées restent à rapprocher. Cette reprise nécessite les workers actifs ; elle est désactivée en mode `MIGRATION_PREPARATION=1`.

## Synchronisation du suivi vers Erplain

Le processus `scripts/sync-tracking.mjs` lit les commandes existantes dans PostgreSQL, récupère les événements GLS / GOFO / TEMU puis propose ou applique les statuts `shipped` et `delivered` aux BL existants. Il ne lance pas le serveur ni les autres traitements métier. Il ne crée aucun document, facture ou paiement. Il n'annule pas automatiquement de document à partir d'un incident transporteur.

Configuration : installer les dépendances avec `npm ci`, renseigner `.env` à partir de `.env.example` et fournir `DATABASE_URL` pour la base V3 concernée. Les clés peuvent provenir de `.env` ou des JSON privés du dossier `CREDENTIALS_DIR` ; les variables priment. Les accès TEMU sont vérifiés par boutique (mallId, y compris les jetons associés). Une boutique sans accès ou une IP refusée est signalée dans le rapport. Le coffre Windows et le relais SSH ne sont pas utilisés par ce processus dédié. GLS nécessite les accès Track & Trace, qui peuvent différer des accès de création d'étiquettes.

- `npm run tracking:preview` : lectures API et rapport, sans écriture de statuts Erplain ni de commandes V3. Le budget API et les délais de reprise PostgreSQL sont utilisés pour partager les quotas.
- `npm run tracking:sync` : un cycle avec mise à jour des BL.
- `npm run tracking:watch` : cycles automatiques, espacés de 30 minutes après la fin du cycle précédent ; intervalle réglable par `TRACKING_SYNC_INTERVAL_SECONDS` (minimum 300).
- `npm run test:tracking` : tests isolés, sans API réelle.

Avant un lancement avec écritures : définir `ERPLAIN_LIVE_WRITES=1` et désactiver le traitement historique `lifecycle` dans les contrôles V3 (`POST /api/operations/tasks`, administrateur, corps `{"lifecycle":false}`). Ce traitement historique inclut la facturation et le paiement ; le processus dédié utilise ses verrous BL pour éviter des écritures concurrentes. Aucun déploiement ni changement de ces réglages n'est effectué par l'installation du code.

Le rapport est enregistré dans `data/tracking-sync-report.json` (ou `TRACKING_SYNC_REPORT`), avec la référence, les colis, les événements, le statut précédent, le statut proposé et les erreurs. Les écritures sont également tracées dans `audit`. Tous les colis d'un BL doivent avoir des événements exploitables ; un incident ou une lecture incomplète bloque ce BL. Chaque BL partiel est traité séparément. Les étiquettes de test, commandes archivées et transports non pris en charge sont exclus. Une suspension bloque la mise à jour. Les BL sont rapprochés de leur BC avant écriture, puis relus pour confirmer le statut. Après une réponse incertaine, le prochain cycle relit Erplain avant toute nouvelle décision. Un verrou laissé par un processus interrompu nécessite un rapprochement manuel.

Ce processus requiert le schéma PostgreSQL V3 actuel ; il ne crée pas de base ni ne migre une ancienne copie PGlite. Les comptes/API et les commandes réelles doivent être validés sur l'environnement retenu avant la mise en service.

### Bouton et historique dans V3

Le bouton **Synchroniser les statuts**, à côté d'Actualiser dans Commandes, lance une tâche persistante en arrière-plan et ouvre la fenêtre de suivi. Pour le test, il exige de 1 à 5 commandes principales cochées. La sélection est figée au clic ; une sélection vide, des lignes de livraison partielle ou plus de 5 commandes bloquent le lancement. Le serveur valide également cette limite et refuse les anciennes tâches globales encore en attente. Les filtres visuels ne constituent pas une sélection. Les résultats et l’export de la fenêtre sont limités à la tâche lancée. Cette limite concerne le bouton et son API, pas le processus CLI dédié. **Historique des suivis** ouvre les résultats enregistrés sans appeler les transporteurs.

La fenêtre affiche le transporteur, les numéros de suivi, le dernier statut physique, le statut Erplain effectivement relu, les dates et les erreurs. Les changements observés sont conservés en base, avec les valeurs avant/après ; les scans transporteurs sont présentés séparément avec leur date d'origine. L'historique commence à la première synchronisation effectuée par ce nouveau processus ; il ne reconstitue pas les anciens changements Erplain. Une erreur conserve le dernier statut connu et sa date. La recherche et la pagination permettent de retrouver une commande, un BL ou un colis.

Les administrateurs, managers et opérateurs peuvent lancer une tâche ; les autres rôles peuvent consulter l'historique. Si une tâche est déjà active, le bouton signale que la nouvelle sélection n’a pas été lancée ; son avancement reste consultable dans l’historique. Fermer la fenêtre n'arrête pas la tâche. Après un redémarrage, une tâche en cours est signalée comme interrompue et les résultats reçus restent accessibles. Le worker `tracking-sync` doit être actif. La fermeture de la fenêtre actualise le tableau des commandes.

Le serveur charge maintenant `.env` au démarrage pour ce connecteur (les variables déjà définies dans l'environnement priment). Si les écritures Erplain ne sont pas configurées, le bouton actualise les suivis V3 et conserve les propositions de changement des BL. Avec `ERPLAIN_LIVE_WRITES=1` et l'ancien `lifecycle` désactivé, il applique aussi les statuts des BL dans Erplain. L'écran indique le mode utilisé. Les autres connecteurs historiques conservent leurs configurations JSON.

Les tables `tracking_sync_runs`, `tracking_sync_observations` et `tracking_sync_changes` sont initialisées au démarrage. Les passages du processus CLI alimentent également l'historique consultable dans V3, y compris en mode aperçu. Les tests `npm run test:tracking` couvrent la file, les droits, les transitions, les erreurs et la persistance sur une base PGlite isolée.

Le bouton **Télécharger Excel** exporte toutes les pages de la recherche appliquée dans cette fenêtre, depuis les données déjà enregistrées. Le classeur contient les feuilles **Statuts** (V3, transporteur, Erplain connu et proposé, écarts, dates, erreurs), **Historique** (changements avant/après), **Événements** (scans présents dans le dernier résultat enregistré) et **Informations** (périmètre et fraîcheur). Les dates sont en UTC. Les numéros de suivi restent du texte pour conserver leurs zéros initiaux. Le téléchargement ne relance aucune API ; pour un contrôle à jour, terminer d'abord une synchronisation. Il est également accessible aux profils de consultation. Les commandes jamais synchronisées ne sont pas incluses.

### Import Excel TEMU multi-pays

Dans Imports de fichiers, choisir **Commandes TEMU · Excel multi-pays** pour analyser un ou plusieurs exports pays ensemble. L’aperçu regroupe les commandes, signale les doublons et les erreurs, puis permet de confirmer les nouvelles commandes sélectionnées. Elles sont ajoutées en attente de validation, sans préparation automatique. Voir [le fonctionnement et les limites](docs/import-temu-excel.md).
