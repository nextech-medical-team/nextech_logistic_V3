# NEXTECH LOGISTIC V3

Sources Node.js24 de l'application. `npm ci --ignore-scripts`, `npm run check` et `npm test` exécutent les contrôles isolés. Données, documents, étiquettes, coffres et identifiants de production sont exclus du dépôt.

Après initialisation de l'exécuteur Section7, chaque push sur `main` déclenche tests puis publication automatique, sous contrôle de la file commune et du verrou serveur. Configuration et retour arrière : [deploy/README.md](deploy/README.md).

La copie publique contient des sources épurées. Ne jamais écraser une différence privée ni les développements serveur concurrents. Ne pas connecter le développement aux services métier réels sans autorisation spécifique.
