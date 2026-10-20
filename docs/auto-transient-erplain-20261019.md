# Incidents Erplain en attente

Branche : `fix/auto-transient-erplain-20261019`. Base : `e18724e` (main, 19 octobre 2026).

Les anciens messages « reprise automatique en attente (0/3) » restent éligibles au rapprochement même si lastError manque. Le contrôle relit les documents puis remet la tâche en attente de préparation.

Trois tentatives maximum ; commandes suspendues, archivées, partielles ou en attente de validation exclues.

## Validation

`node --test test/erplain-transient-recovery.test.mjs test/erplain-recovery-fluidity.test.mjs test/erplain-live-recovery.test.mjs`

30 tests réussis. Vérification syntaxique des fichiers JavaScript modifiés et `git diff --check` réussies. Les tests utilisent des données et fournisseurs simulés ; aucun appel de production.

Cette branche est indépendante des sept autres et ne déploie rien.

## Complément du 20 octobre : attente créée avant la fin du worker

Le contrôle serveur en lecture seule a identifié deux dossiers TEMU en `bl_created`, BC actif et BL `pending`, avec `lastError=Erplain HTTP 429` et `resolution_pending_resume=true`. Leur dernière intervention `resume` est `complete`, avec `result.resume=true` et `result.erpOnly=true`, quelques secondes avant le refus du worker. Le premier correctif de reconnaissance du message ne suffisait donc pas.

Le suivi ne clôture plus une reprise TEMU pendant un job ERP pending/processing ; un refus temporaire passe en revue « Erplain à compléter » sans réappliquer l'attente. Les anciens dossiers peuvent reprendre uniquement sur la preuve de cette dernière intervention explicite terminée avant l'erreur. Les nouvelles interventions, corrections actives, suspensions, annulations, livraisons partielles/expédiées, doublons, délais futurs et tentatives épuisées restent exclus. Une autorisation déjà consommée ne libère jamais une nouvelle attente. Les identifiants et l'ancienne attente sont conservés dans le journal ERP et le résultat de l'intervention.

La libération locale ne valide pas les documents : le rapprochement existant relit ensuite les mêmes BC/BL, hors transaction, avant toute remise en file du worker normal. Une identité différente reste en revue ; un quota de lecture conserve ses délais et son compteur. Aucune nouvelle création ou achat d'étiquette n'est déclenché par ce rapprochement ; la politique d'achat existante est inchangée.

Tests SQL isolés : les deux checkpoints observés, exclusions, quota, BL différent et nouvelle attente pendant la lecture ; régression de fermeture prématurée du suivi. Aucune écriture métier sur le serveur ni publication. `main` 014fc6c a été intégré à cette branche avant le complément.

Le suivi de la reprise TEMU retire également le message `(0/3)` après une fin ERP confirmée et plus récente. Pour cette reprise documentaire explicite uniquement, le BL `pending` ou `in_preparation` est accepté sans changement de son statut ; la preuve `bl_ready`/BC avec stock et les contrôles de complétude restent nécessaires. Les autres circuits et les anciennes protections de statut restent inchangés.

Validation ciblée du complément : 55 tests réussis (registre d'attente, suivi, priorité/quota et clôture), puis régressions de rapprochement/publication et suspension ; contrôle syntaxique global réussi. La suite générale est lancée avant envoi sur la branche. Ces tests ne certifient pas la fin métier des commandes de production : seule une recette après publication pourra l'établir.
