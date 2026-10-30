# Rapprochement des sources du serveur et de main — 29 octobre 2026

La comparaison porte sur `src/`, `public/`, `package.json` et `package-lock.json`, à partir de main `69b4d09e90a1e282e6af67cff9b58a63be228d83`. L'inventaire a été vérifié contre la sauvegarde locale du serveur avant toute préparation. Aucun service n'a été redémarré et aucun document Erplain, achat d'étiquette ou traitement de commande n'a été lancé.

Les 57 différences comprennent 26 différences de fins de ligne, six améliorations présentes uniquement dans main, 22 corrections uniquement sur le serveur, un contrôle de lots enrichi, le parcours Shopify combinant déjà les deux sources et un périmètre privé d'annulations. Six modules supplémentaires présents sur le serveur ont été récupérés. Les fins de ligne LF et les améliorations Shopify de main sont conservées. Les corrections de récupération des BL, de colis supplémentaires, de stock historique, de verrous PostgreSQL et de routage GLS Pharma du serveur sont reprises.

La colonne `extra_parcels.delivery_id` reçoit une migration additive pour les installations déjà initialisées. Elle ne réinitialise pas les envois en cours. Les contrôles de stock historiques restent bloquants en l'absence de preuve ; la surveillance ordinaire conserve ses délais et son regroupement des lectures.

## Configuration privée à conserver avant installation

Le module du serveur contenait une liste d'identifiants de commandes et un identifiant de réception. Ces valeurs sont exclues du dépôt. Le module versionné charge désormais `cancelled-import-reimport-scope.json` dans `DATA_DIR` (répertoire `data/` par défaut). Le fichier contient `orderIds` (tableau d'UUID), `receiptId` (UUID) et `receivedAt` (horodatage UTC exact, y compris les microsecondes). L'absence du fichier désactive uniquement ce périmètre historique ; une configuration invalide est refusée.

Sur le serveur contrôlé, ce fichier a été préparé dans le répertoire de données privé avec le propriétaire du service et le mode `0600`. Une comparaison des clauses SQL avant/après a confirmé que le périmètre reste identique, sans journaliser les identifiants. Ni cette configuration, ni les référentiels privés de marges/rapports ne doivent être copiés dans Git.

## Publication

Faire relire la branche de rapprochement, exécuter les contrôles obligatoires et fusionner via une pull request. Utiliser ensuite le workflow manuel décrit dans [le guide de déploiement](../deploy/README.md). Ne pas copier les sources directement sur `/opt/nextech/current` et ne pas modifier les empreintes de référence pour masquer une divergence. Un nouveau changement constaté sur le serveur impose une nouvelle comparaison.

La correction de comparaison des marges TEMU reste sur sa branche dédiée ; elle n'est pas incluse dans ce rapprochement.
