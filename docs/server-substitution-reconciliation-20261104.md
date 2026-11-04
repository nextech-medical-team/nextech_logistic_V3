# Réconciliation des sources de production — 4 novembre 2026

Le déploiement de la PR #312 (faa625b) a été refusé avant installation : stock-substitution.mjs différait de sa référence enregistrée. Une vérification complète a identifié douze fichiers divergents et deux modules supplémentaires nécessaires à leurs corrections. La clôture de la demande échouée exige de rapprocher tous ces écarts, pas uniquement le premier fichier signalé.

Le commit de provenance d1fea40 contient les octets exacts des quatorze fichiers du serveur. Le manifeste deploy/server-reconciliation-20261104.json associe chaque chemin à son SHA-256 serveur et candidat. Les données privées, PDF, environnement, dépendances et fichiers non applicatifs sont exclus.

Les corrections préservées portent sur les PDF des BL associés, les filtres par représentant Erplain, les mouvements historiques de stock, la récupération des BC absents, les lots hérités du BC parent, les étiquettes TEMU déjà payées et les noms GLS. Les protections de reprise des remplacements historiques sont conservées : aperçu enregistré avant mutation et réutilisé après interruption, refus des preuves modifiées. Le contrôle du mapping de la PR #312 reste placé avant tout appel fournisseur. Aucune correction des prix ou des commandes réelles n’est incluse.

Le planificateur installé doit vérifier la fusion à trois voies de toutes ces sources. Le candidat reprend treize fichiers exactement ; seul stock-substitution.mjs ajoute le contrôle du mapping aux octets serveur.

Avant publication, Section 7 doit acquérir le verrou de déploiement, vérifier chaque octet contre le commit de provenance Git, valider le candidat avec reconcile_overlay_sources, sauvegarder la référence, puis enregistrer uniquement les overlays vérifiés. Le commit déployé ne doit pas être avancé à cette étape. Toute nouvelle divergence bloque l’opération.

La demande échouée doit ensuite recevoir un certificat serveur réel via restoration_certificate : empreintes, environnement, services et HTTP. Le rapport d’échec original est conservé. La publication passe enfin par le workflow manuel et ses tests, sauvegardes et contrôles de fin.
