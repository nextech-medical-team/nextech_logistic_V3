# Circuit ERPLAIN : efficacité, traçabilité et retour arrière

Base : main 5df9641 (PR205/218 incluses). Ne pas réappliquer PR156/191/198/199/202/207/213/215/216/205/218. Les compléments 209/210/212/214 gardent leur file et leurs propriétaires. PR206 financière est exclue. Ce lot ne lève aucune suspension, n'importe aucune commande, n'achète aucune étiquette de recette et ne modifie aucun document existant pour les tests.

## Modifications

- Reprises automatiques identifiées par produits, quantités, stock observé et état métier, sans horodatage par minute. Les actions manuelles restent distinctes.
- Les diagnostics des reprises ne réveillent plus une nouvelle lecture externe. Corrections achevées et changements de lignes continuent de réveiller le moniteur. Au démarrage, les échéances externes persistées sont conservées.
- Surveillance native du manque de stock par variante, avec tous les emplacements complets : une requête groupée de cinq variantes, au plus 100 variantes par passage, minimum 60 secondes entre lectures d'une même variante. Une variation est un signal de réveil, jamais une preuve autorisant le BL. Au plus 20 lectures de BC par passage, nouvelles exigences comprises. Les exigences sont persistées et reconstruites si absentes. Réexamen individuel des réservations au plus tard lors du rattrapage de 15 minutes, sous réserve de disponibilité fournisseur et de capacité du lot. Un dépassement du budget signifie attente, jamais stock positif supposé.
- Compatibilité réservation native `update_stock=true`, sans l'ancienne recherche de sortie séparée sur les mêmes références. Anciens cycles conservés. Les commandes partielles et AO ne sont pas converties implicitement en cycle natif.
- La disponibilité propre à chaque BC est vérifiée avant admission de reprise ; le worker conserve le contrôle frais sous verrou avant création du BL. Si deux BC attendent le même stock, être mis en file ne vaut pas attribution du stock : la seconde vérification reste obligatoire.
- Après création native du BL : pas de nouvelle preuve de journaux, ni de lecture BC dans la vérification finale des documents ou la finalisation ready. Le statut source du BL reste lu, et le connecteur conserve sa garde obligatoire immédiatement avant mutation. `in_preparation` vers `ready_to_ship` reste interdit.
- Réponse complète d'activation BC réutilisée. Si les informations requises ne sont pas reçues, lecture ciblée conservée. Réutilisation d'un BC actif dans la même opération, sans réutiliser un brouillon après activation.
- Mutualisation uniquement des lectures simultanées explicitement autorisées (catalogue et affichage/actualisation documentaire). Pas de TTL sur ces réponses. Les gardes finales de stock, statut et numérotation n'utilisent pas cette mutualisation.
- Journal local `erplain.request` : opération GraphQL, origine de tâche, statut HTTP, résultat, durée, attente et tentative. Aucun jeton, URL, variable, contenu client ou corps de réponse. Distinguer les événements HTTP, réseau, admission locale et signal GraphQL ; ne pas additionner ces événements comme des requêtes HTTP indépendantes.
- Copies actives retirées de l'import, même si un ancien client envoie `duplicateSelection`. Réceptions répétées, modifiées, invalides et exclues d'une sélection conservées séparément lors de confirmation. Historique accessible en lecture authentifiée `/api/import/receptions?orderId=...` ou `?reference=...`, 100 lignes maximum par lecture. Les retransmissions du même requestId restent idempotentes.
- Recherche BC : un numéro client réutilisable n’est jamais une preuve d’identité du document. Deux plateformes/boutiques de même référence ne sont distinguées automatiquement qu’avec BC local associé et marqueur documentaire fournisseur concordant. Une recherche incomplète ou un BC annulé n’autorisent jamais une nouvelle création. Un ancien cycle documenté permet seulement de retrouver un BC actif déjà existant.
- Identité Shopify par ID source et boutique connue ; boutique inconnue ou conflit : observation explicite, aucune fusion ou copie. Deux boutiques connues sont conservées séparément avec référence d'affichage qualifiée et référence commerciale d'origine conservée pour ERPLAIN. Import ERPLAIN de même référence et BC fournisseur sans marqueur V3 : rapprochement requis avant toute nouvelle création.
- Gestionnaire manquant/ambigu : pas de choix arbitraire, observation d’origine et omission du champ facultatif ; une correspondance d’une autre société reste refusée.
- Écarts de montants source, remises et retenues : observations non bloquantes ; les règles de remise ERPLAIN sont activées lorsque la remise source ne peut pas être transposée sans supposition. Les valeurs source restent conservées.
- Écart entre total source reçu et calcul des lignes : observation non bloquante. Aucun prix absent n'est inventé. Quantités invalides refusées même pour un produit non suivi en stock. Ancienne mutation fiscale incertaine : seul un rapprochement structurel produits/quantités/politique, à partir de sa preuve avant écriture, peut établir qu'elle n'a pas d'effet logistique. Aucun test de TVA/prix/totaux ni réécriture fiscale déduite.

## Interrupteurs de repli

Section7 seule change l'environnement et redémarre après fin naturelle des traitements. Sauvegarder les valeurs actuelles, y compris l'absence d'une variable. Valeur `0` désactive le comportement indiqué ; retirer le réglage réactive la valeur par défaut.

| Variable | Effet de 0 |
|---|---|
| ERPLAIN_GROUPED_STOCK_WATCH | Ancien moniteur BC groupés, en conservant le support de réservation native et les protections métier |
| ERPLAIN_STABLE_RECHECKS | Ancienne planification/identité de reprise ; redémarrage nécessaire pour redéfinir les déclencheurs SQL |
| ERPLAIN_INFLIGHT_READS | Lectures de catalogue/document indépendantes |
| ERPLAIN_BC_RESPONSE_REUSE | Relecture de confirmation BC systématique |
| ERPLAIN_NATIVE_READY_FAST | Finalisation prête historique, avec davantage de lectures |
| ERPLAIN_REQUEST_TELEMETRY | Arrêt des événements locaux détaillés |

Les interrupteurs de performance ne retirent pas l'anti-doublon, les suspensions, les contrôles de quantité ou la garde de statut. Si une branche de repli conserve un contrôle historique plus restrictif, elle peut ralentir/bloquer ; elle ne doit pas déclencher de mutation corrective.

## Retour du code

1. Identifier le périmètre réellement défaillant par les journaux et résultats. Arrêter les nouvelles admissions concernées avec les contrôles de tâches existants, sans interrompre une écriture en cours.
2. Relever les jobs actifs et les identifiants BC/BL/transporteur. Laisser finir naturellement ; rapprocher les réponses perdues. Aucun reset global ni rejeu d'écriture incertaine.
3. Privilégier l'interrupteur du composant défaillant. Pour un retour de code, partir de la version installée au moment de l'incident et rétablir uniquement les changements de ce lot : ne pas écraser les PR publiées ensuite. Section7 prépare/reteste le cumul et utilise son circuit habituel de sauvegarde/verrou/publication.
4. Garder les tables additionnelles `stock_resume_requirements`, `stock_resume_resources` et `order_import_receptions`. L'ancienne version peut les ignorer. Ne pas les supprimer et ne pas restaurer globalement une ancienne base après des écritures fournisseur.
5. Avant retour complet à un import ancien qui permettait les copies, conserver le refus de copies en correctif minimal ou suspendre cet import jusqu'à rétablissement de cette protection. Ne pas réintroduire volontairement un doublon actif.
6. Vérifier version, services, état des contrôles de tâches restaurés, lecture de file et absence de nouvelles opérations dupliquées. Les BL, réservations, mouvements et étiquettes créés pendant l'intervalle restent réels ; un rollback code ne les annule jamais.

## Vérification et limites

Tests isolés : stock inchangé, réapprovisionnement, partage d'une variante entre commandes, redémarrage, signal perdu, rattrapage, panne fournisseur et cooldown, suspension en cours de lecture, mauvaise identité, réponse incomplète, quantité invalide, concurrence des lectures, état SQL des déclencheurs, anti-doublons inter-fichiers, source modifiée, boutiques, correspondance ERP et absence de rejeu. UI synthétique réelle ordinateur/mobile, aucune écriture fournisseur. Déploiement et vérification installée restent exclusivement Section7 ; recette métier LIVE distincte.

Un manque de prix techniquement exploitable, un identifiant de boutique indéterminé, une ancienne sortie de stock incertaine ou une suspension explicite ne sont pas résolus par une supposition. Les scripts extérieurs qui n'utilisent pas le connecteur installé doivent être rapprochés séparément : leur consommation ne peut pas être garantie par ce seul patch. Zéro 429 fournisseur n'est pas promis.
