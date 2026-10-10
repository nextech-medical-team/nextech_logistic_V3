# Publication automatique de V3

Chaque push sur `main` déclenche `.github/workflows/deploy.yml`. Les branches et pull requests passent les contrôles sans accéder à la production. Le job de publication ne démarre qu'après `npm ci`, les vérifications syntaxiques, les tests applicatifs et les tests de déploiement/retour arrière.

Le job utilise l'environnement GitHub `production`, limité à `main`. Variables de cet environnement : `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_KNOWN_HOSTS`. Secret : `DEPLOY_SSH_KEY`. Ne jamais mettre cette clé dans Git. La vérification de l'empreinte SSH est obligatoire ; ne pas utiliser `StrictHostKeyChecking=no`.

La clé ne permet qu'une commande `deploy <SHA>` ; aucun shell, transfert de fichiers, tunnel ou agent SSH. L'exécuteur Section 7 installé sur le serveur récupère lui-même le dépôt public en HTTPS et accepte uniquement le SHA courant de `main`, descendant de sa référence publiée. Une ancienne exécution dépassée par un nouveau push est signalée comme telle.

## Initialisation par la Section 7

La Section 7 installe une seule fois les quatre fichiers de confiance dans `/usr/local/lib/nextech-cicd`, avec `bootstrap.py` et un inventaire SHA récent du serveur. Cette installation conserve les sources, les services et l'environnement existants. Elle s'effectue sous `/var/lock/nextech-deploy.lock`, via la file et les preuves partagées. Les mises à jour de cet exécuteur privilégié suivent le même circuit ; du code provenant du dépôt n'est jamais automatiquement exécuté en tant que root.

Le fichier `/var/lib/nextech-cicd/baseline.json` relie le commit publié aux empreintes serveur. Les données, PDF, étiquettes, configurations privées et fichiers non suivis restent en place. La copie Git comporte des sources épurées : une modification touchant une source privée divergente est refusée et doit être rapprochée par Section 7, jamais écrasée. Tout conflit avec une modification serveur postérieure bloque aussi la publication avec le chemin exact.

## Production et secrets

Les services `nextech-web` et `nextech-worker` chargent `/etc/nextech/application.env` via systemd. Ce fichier est extérieur au dépôt, détenu par root, sans droit pour les autres utilisateurs. Les valeurs et les options métier existantes sont conservées. Le pipeline vérifie la présence des variables requises et l'intégrité de ce fichier, sans le journaliser ni le recopier dans les artefacts GitHub. Les coffres fournisseurs restent sur le serveur. `production.env.example` documente les noms, uniquement avec des valeurs fictives.

Le build s'exécute sous `nextech-build`, sans environnement de production ni accès aux coffres. `npm ci --ignore-scripts` évite d'exécuter les scripts d'installation des dépendances. Si une future dépendance exige un script natif, sa procédure doit être revue avant activation.

## Publication et erreurs

Un seul déploiement s'exécute à la fois : concurrence GitHub et verrou serveur commun Section 7. Après tests serveur, seules les différences `src/`, `public/`, `package.json` et `package-lock.json` sont installées. Les fichiers et dépendances remplacés sont sauvegardés dans `/var/backups/nextech/cicd-*`.

Pour un changement backend, l'exécuteur suspend temporairement l'ordonnancement, attend la fin naturelle des travaux, contrôle les arrêts propres, installe, puis redémarre le web et le worker. Il rétablit les contrôles en conservant les modifications humaines concurrentes. Un changement uniquement statique ne redémarre pas les services. Les SHA installées, l'état des services, HTTPS200 et les octets de la page servie sont vérifiés avant validation du commit publié.

En cas d'échec après installation, seuls les fichiers/dépendances concernés sont restaurés, puis les services et HTTP sont contrôlés. Un échec de restauration ou de reprise des contrôles signale une intervention nécessaire dans le rapport ; il ne doit pas être présenté comme un déploiement réussi. Le rollback concerne le code, pas les données ni les écritures externes. Toute migration de données irréversible nécessite un plan spécifique avant fusion ; ce mécanisme ne restaure pas la base et ne rejoue aucune écriture métier.

Les rapports sans secrets sont stockés dans `/var/lib/nextech-cicd/reports` et dans les artefacts GitHub Actions. Consulter le job rouge en cas d'échec. Pour réessayer après résolution, relancer le workflow sur `main` ; le même commit est idempotent si les fichiers publiés n'ont pas changé. Pour suspendre les publications, désactiver le workflow GitHub ; ne pas arrêter les services de l'application.
