# Publication manuelle de V3

Dans GitHub, ouvrir **Actions → Déployer V3 manuellement → Run workflow**, sélectionner **main**, puis cliquer **Run workflow**. Seul ce déclenchement manuel lance `.github/workflows/deploy.yml`. Un push ou une fusion ne publie plus automatiquement. Le commit sélectionné au lancement doit encore être le dernier de `main` lors de la publication ; sinon relancer manuellement après vérification. Les branches et pull requests passent les contrôles sans accéder à la production. Le job de publication ne démarre qu'après `npm ci`, les vérifications syntaxiques, les tests applicatifs et les tests de déploiement/retour arrière.

La branche principale exige une pull request, une revue et le contrôle `Vérifications V3` avant fusion. Le nom de ce contrôle est distinct des jobs de publication pour éviter les statuts ambigus. La publication manuelle intervient sur demande après la fusion sur `main` ; les branches de travail des collègues ne sont pas publiées directement.

Le job utilise l'environnement GitHub `production`, limité à `main`. Variables de cet environnement : `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_KNOWN_HOSTS`. Secret : `DEPLOY_SSH_KEY`. Ne jamais mettre cette clé dans Git. La vérification de l'empreinte SSH est obligatoire ; ne pas utiliser `StrictHostKeyChecking=no`.

La clé ne permet qu'une commande `deploy <SHA>` ; aucun shell, transfert de fichiers, tunnel ou agent SSH. L'exécuteur Section 7 installé sur le serveur récupère lui-même le dépôt en HTTPS et accepte uniquement le SHA courant de `main`, descendant de sa référence publiée. Une ancienne exécution dépassée par un nouveau push est signalée comme telle.

Le job de publication transmet son `GITHUB_TOKEN` temporaire, limité à `contents: read`, dans le flux SSH avec les preuves. L’exécuteur retire ce jeton du paquet avant de traiter ou enregistrer les preuves et le transmet uniquement au processus Git chargé de récupérer le dépôt exact. Il ne l’enregistre ni dans la configuration Git ni dans les rapports. Aucun PAT, deploy key ou nouvelle GitHub App n’est nécessaire. Les redirections HTTP et les invites interactives sont désactivées. Les anciens paquets sans jeton restent lisibles, mais nécessitent un accès anonyme au dépôt.

Cette évolution nécessite l’installation contrôlée de la nouvelle version de `dispatcher.py` sur le serveur avant la première exécution du workflow modifié ; une fusion seule ne remplace pas l’exécuteur privilégié. L’installation conserve le verrou de publication, la file commune, la sauvegarde et les empreintes serveur. Les autres fichiers de l’exécuteur, l’application et ses services ne changent pas.

## Initialisation par la Section 7

La Section 7 installe une seule fois les sept fichiers de confiance dans `/usr/local/lib/nextech-cicd`, avec `bootstrap.py` et un inventaire SHA récent du serveur. Cette installation conserve les sources, les services et l'environnement existants. Elle s'effectue sous `/var/lock/nextech-deploy.lock`, via la file et les preuves partagées. Les mises à jour de cet exécuteur privilégié suivent le même circuit ; du code provenant du dépôt n'est jamais automatiquement exécuté en tant que root.

Le fichier `/var/lib/nextech-cicd/baseline.json` relie le commit publié aux empreintes serveur. Les données, PDF, étiquettes, configurations privées et fichiers non suivis restent en place. La copie Git comporte des sources épurées : une modification touchant une source privée divergente est refusée et doit être rapprochée par Section 7, jamais écrasée. Tout conflit avec une modification serveur postérieure bloque aussi la publication avec le chemin exact.

## Production et secrets

Les services `nextech-web` et `nextech-worker` chargent `/etc/nextech/application.env` via systemd. Ce fichier est extérieur au dépôt, détenu par root, sans droit pour les autres utilisateurs. Les valeurs et les options métier existantes sont conservées. Le pipeline vérifie la présence des variables requises et l'intégrité de ce fichier, sans le journaliser ni le recopier dans les artefacts GitHub. Les coffres fournisseurs restent sur le serveur. `production.env.example` documente les noms, uniquement avec des valeurs fictives.

Le build s'exécute sous `nextech-build`, sans environnement de production ni accès aux coffres. `npm ci --ignore-scripts` évite d'exécuter les scripts d'installation des dépendances. Si une future dépendance exige un script natif, sa procédure doit être revue avant activation.

## Publication et erreurs

Un seul déploiement s'exécute à la fois : concurrence GitHub et verrou serveur commun Section 7. Après tests serveur, seules les différences `src/`, `public/`, `package.json` et `package-lock.json` sont installées. Les fichiers et dépendances remplacés sont sauvegardés dans `/var/backups/nextech/cicd-*`.

Pour un changement backend, l'exécuteur suspend temporairement l'ordonnancement, attend la fin naturelle des travaux, contrôle les arrêts propres, installe, puis redémarre le web et le worker. Il rétablit les contrôles en conservant les modifications humaines concurrentes. Un changement uniquement statique ne redémarre pas les services. Les SHA installées, l'état des services, HTTPS200 et les octets de la page servie sont vérifiés avant validation du commit publié.

En cas d'échec après installation, seuls les fichiers/dépendances concernés sont restaurés, puis les services et HTTP sont contrôlés. Un échec de restauration ou de reprise des contrôles signale une intervention nécessaire dans le rapport ; il ne doit pas être présenté comme un déploiement réussi. Le rollback concerne le code, pas les données ni les écritures externes. Toute migration de données irréversible nécessite un plan spécifique avant fusion ; ce mécanisme ne restaure pas la base et ne rejoue aucune écriture métier.

Les rapports sans secrets sont stockés dans `/var/lib/nextech-cicd/reports` et dans les artefacts GitHub Actions. Consulter le job rouge en cas d'échec. Après un échec, une demande ultérieure reste bloquée jusqu’à résolution prouvée sur le serveur par Section7. Une nouvelle version corrigée exige un nouveau commit. Une exécution simplement bloquée avant publication peut être relancée après levée de sa dépendance. Le certificat de restauration vérifie les fichiers, l’environnement, les services, HTTP et les contrôles suspendus ; le client local ne peut pas déclarer seul la restauration réussie. Pour suspendre les publications, désactiver le workflow GitHub ; ne pas arrêter les services de l'application.

## File commune FIFO et preuves de chaque publication manuelle

L'exécuteur refuse de publier tant que la file commune n'est pas initialisée. Une seconde clé locale, distincte de la clé GitHub, est limitée à la commande de synchronisation ; GitHub ne peut pas effacer les demandes des autres sections. `queue.mjs` synchronise les demandes avant toute mutation locale : en cas d'échec, la mutation est refusée. L'instantané inclut les demandes prêtes, en cours, bloquées et les échecs exigeant un remplacement encore non certifié.

Le serveur compare les dates `createdAt` de toutes les demandes locales et CI. Une demande antérieure ou déjà en cours bloque la publication ; l'attente libère le verrou pour permettre à Section7 de traiter cette demande. Une attente prolongée produit un rapport bloqué et exige une reprise après résolution, jamais un dépassement silencieux.

Le workflow fournit un manifeste prêt lié au SHA exact avec les empreintes des sources et des preuves : vérifications, captures ordinateur/mobile et mesure isolée. L'exécuteur revalide ready/openGates/commit/proofs/candidat, puis les empreintes serveur et ses propres tests. Les captures utilisent120 commandes fictives et un serveur de fixture : elles ne certifient pas une opération métier ni la résolution d'une commande réelle. Les tests spécifiques à une évolution doivent être ajoutés par son auteur avant fusion.

Les demandes CI et leurs rapports sont conservés sur le serveur et ramenés dans `coordination-deploiement/requests` et `cicd-rapports` par `queue.mjs sync`. Ces demandes portent serverManaged : ne pas les republier par le lanceur local. Section7 synchronise à chaque reprise pour lire le résultat final. Si la dernière file locale confirmée est vide, une publication manuelle GitHub peut fonctionner même PC éteint ; un nouvel enqueue local ne peut être enregistré sans avoir été synchronisé au serveur.

Le bouton conserve les tests, la file FIFO, les protections GitHub, la sauvegarde, le verrou serveur et la fin naturelle des traitements. Il ne lève pas une dépendance métier ou une divergence de sources. La surveillance Section7 peut préparer et vérifier, mais ne doit plus déclencher de publication automatiquement.


## Budget des tests isolés serveur

La suite npm test dispose de 1 800 secondes, avec échec bloquant à expiration avant sauvegarde, pause ou installation. Le diagnostic du 20 octobre 2026 sur le commit 2ed0f6cd87ae1f3ce033d5e666c6f8811272fe44 a terminé les 61 groupes en 1 261,46 secondes, sans échec, sous le compte isolé nextech-build avec une priorité nice 10. Cette mesure dépasse le plafond précédent de 1 200 secondes ; elle ne démontre pas une régression fonctionnelle. Le budget de 30 minutes garde une marge bornée pour les variations de charge, sans supprimer de tests ni transformer un dépassement ou un échec en réussite. Les autres délais restent inchangés.

L’exécuteur installé ne se met pas à jour avec les fichiers applicatifs : sa mise à jour Section7 exige revue, tests, empreinte fraîche, sauvegarde et verrou intégral. Une demande échouée reste conservée ; publier un nouveau commit après correction, sans réinitialiser ni rejouer la demande échouée.

## Rapprochement du correctif de débit BC installé le 23 octobre

Le serveur possède un appel à `reconcileNativeBcDebit` absent du commit de référence. La branche de rapprochement conserve ce fichier exact dans le commit `417e38b`, puis intègre le contrôle des lots. Le module `src/native-bc-debit-recovery.mjs` est repris sans modification depuis le serveur. Avant publication, Section7 enregistre les deux sources Git et leurs empreintes dans `reconciliation.preservedOverlays`, après comparaison complète des empreintes serveur, sous verrou avec sauvegarde. La référence publiée reste inchangée.

L’exécuteur doit recevoir la version revue de `plan.py` : un module précédemment hors Git n’est reconnu que si son contenu candidat est strictement identique au fichier serveur, à son empreinte déjà enregistrée et à sa source Git déclarée. Il n’est alors ni remplacé ni supprimé. Toute divergence reste bloquante. Le rapprochement du workflow existant doit conserver le correctif serveur par fusion à trois versions. L’échec précédent doit être certifié sans installation ni pause avant une nouvelle publication du commit corrigé.
