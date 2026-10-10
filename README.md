# NEXTECH LOGISTIC V3

Sources de l'application actuellement publiée, récupérées le 10 octobre 2026 et vérifiées par empreintes SHA-256 contre le serveur.

Le dossier `src/` contient le backend et les connecteurs ; `public/` contient l'interface. Node.js 24 ou supérieur est requis. Installation des dépendances : `npm ci`. Démarrage : `npm start`, après configuration d'un environnement isolé approprié.

Les bases de données, documents, étiquettes, journaux et identifiants de production sont volontairement exclus. Ne jamais connecter un environnement de développement aux services métier réels sans autorisation spécifique.

Le serveur publié ne contient pas les dossiers `scripts/` et `test/`. Les commandes `npm test` et `npm run check` du package d'origine référencent des scripts absents de cet export. Les vérifications syntaxiques ont été exécutées séparément ; cet export ne constitue pas une validation fonctionnelle complète.

La publication GitHub ne déclenche pas de déploiement serveur. Les publications et redémarrages V3 restent exclusivement centralisés par la Section 7 via la file commune du projet.

Les instantanés métier margin-published-snapshot.json et temu-reading-reports.json sont exclus. Le périmètre privé de réimport TEMU est vide dans cette copie : aucun réimport de ce lot ne peut être autorisé par cette copie. Le service de marges nécessite son fichier de configuration privé pour démarrer. Ces exclusions concernent seulement le dépôt public ; le serveur reste inchangé.
Les identifiants privés du lot cancelled-import-reimport sont aussi retirés ; ce lot reste désactivé dans la copie publique.

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

Le bouton **Synchroniser les statuts**, à côté d'Actualiser dans Commandes, lance une tâche persistante en arrière-plan et ouvre la fenêtre de suivi. Il traite les commandes sélectionnées, ou toutes les commandes actives éligibles si aucune case n'est cochée. Les filtres visuels ne limitent pas cette dernière portée. **Historique des suivis** ouvre les résultats enregistrés sans appeler les transporteurs.

La fenêtre affiche le transporteur, les numéros de suivi, le dernier statut physique, le statut Erplain effectivement relu, les dates et les erreurs. Les changements observés sont conservés en base, avec les valeurs avant/après ; les scans transporteurs sont présentés séparément avec leur date d'origine. L'historique commence à la première synchronisation effectuée par ce nouveau processus ; il ne reconstitue pas les anciens changements Erplain. Une erreur conserve le dernier statut connu et sa date. La recherche et la pagination permettent de retrouver une commande, un BL ou un colis.

Les administrateurs, managers et opérateurs peuvent lancer une tâche ; les autres rôles peuvent consulter l'historique. Les clics multiples partagent la tâche active. Fermer la fenêtre n'arrête pas la tâche. Après un redémarrage, une tâche en cours est signalée comme interrompue et les résultats reçus restent accessibles. Le worker `tracking-sync` doit être actif. La fermeture de la fenêtre actualise le tableau des commandes.

Le serveur charge maintenant `.env` au démarrage pour ce connecteur (les variables déjà définies dans l'environnement priment). Si les écritures Erplain ne sont pas configurées, le bouton actualise les suivis V3 et conserve les propositions de changement des BL. Avec `ERPLAIN_LIVE_WRITES=1` et l'ancien `lifecycle` désactivé, il applique aussi les statuts des BL dans Erplain. L'écran indique le mode utilisé. Les autres connecteurs historiques conservent leurs configurations JSON.

Les tables `tracking_sync_runs`, `tracking_sync_observations` et `tracking_sync_changes` sont initialisées au démarrage. Les passages du processus CLI alimentent également l'historique consultable dans V3, y compris en mode aperçu. Les tests `npm run test:tracking` couvrent la file, les droits, les transitions, les erreurs et la persistance sur une base PGlite isolée.

Le bouton **Télécharger Excel** exporte toutes les pages de la recherche appliquée dans cette fenêtre, depuis les données déjà enregistrées. Le classeur contient les feuilles **Statuts** (V3, transporteur, Erplain connu et proposé, écarts, dates, erreurs), **Historique** (changements avant/après), **Événements** (scans présents dans le dernier résultat enregistré) et **Informations** (périmètre et fraîcheur). Les dates sont en UTC. Les numéros de suivi restent du texte pour conserver leurs zéros initiaux. Le téléchargement ne relance aucune API ; pour un contrôle à jour, terminer d'abord une synchronisation. Il est également accessible aux profils de consultation. Les commandes jamais synchronisées ne sont pas incluses.
