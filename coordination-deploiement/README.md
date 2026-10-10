# Vérifications avant publication V3

La demande humaine du 10 octobre exige les contrôles à chaque changement.

`npm run check` vérifie la syntaxe des sources ; `npm test` vérifie le filtre et le refus des manifestes incomplets. GitHub Actions exécute ces commandes à chaque push et pull request. Ces commandes ne démarrent pas l'application, ne contactent pas les fournisseurs et ne déploient rien.

Le circuit local partagé `queue.mjs` utilise `validatePublicationReadiness(root, manifest)` avant le dépôt et avant la publication des nouvelles demandes. Le manifeste doit contenir `ready: true`, `openGates: []`, un commit distant vérifié et les preuves liées à ce commit : fonctionnement, comparaison serveur, performances, visuel ordinateur et mobile. Les fichiers préparés et les preuves sont contrôlés par SHA-256. Une étape non applicable doit être justifiée ; les preuves doivent décrire précisément leur environnement et leurs limites.

La Section 7 publie exclusivement, sous verrou et après comparaison des empreintes actuelles, sauvegarde et contrôles services/HTTP. Toute différence serveur impose une intégration et de nouveaux tests. Après publication, vérifier les fichiers effectivement installés et le parcours du site avant de clôturer. Aucun code envoyé seulement par SSH, aucune écriture métier déduite de ces contrôles. La CI doit être exigée par la protection de la branche si celle-ci est configurée ; la présence du workflow ne configure pas cette protection.
