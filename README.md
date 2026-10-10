# NEXTECH LOGISTIC V3

Sources de l'application actuellement publiée, récupérées le 10 octobre 2026 et vérifiées par empreintes SHA-256 contre le serveur.

Le dossier `src/` contient le backend et les connecteurs ; `public/` contient l'interface. Node.js 24 ou supérieur est requis. Installation des dépendances : `npm ci`. Démarrage : `npm start`, après configuration d'un environnement isolé approprié.

Les bases de données, documents, étiquettes, journaux et identifiants de production sont volontairement exclus. Ne jamais connecter un environnement de développement aux services métier réels sans autorisation spécifique.

Le serveur publié ne contient pas les dossiers `scripts/` et `test/`. Les commandes `npm test` et `npm run check` du package d'origine référencent des scripts absents de cet export. Les vérifications syntaxiques ont été exécutées séparément ; cet export ne constitue pas une validation fonctionnelle complète.

La publication GitHub ne déclenche pas de déploiement serveur. Les publications et redémarrages V3 restent exclusivement centralisés par la Section 7 via la file commune du projet.

Les instantanés métier margin-published-snapshot.json et temu-reading-reports.json sont exclus. Le périmètre privé de réimport TEMU est vide dans cette copie : aucun réimport de ce lot ne peut être autorisé par cette copie. Le service de marges nécessite son fichier de configuration privé pour démarrer. Ces exclusions concernent seulement le dépôt public ; le serveur reste inchangé.
Les identifiants privés du lot cancelled-import-reimport sont aussi retirés ; ce lot reste désactivé dans la copie publique.
