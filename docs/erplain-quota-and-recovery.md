# Quota et reprises ERPLAIN

Le catalogue nécessaire à une commande active conserve la priorité foreground de
la préparation. Il n'est pas déplacé derrière les autres commandes. Le worker
traite au plus trois lignes de rattrapage par passage, puis poursuit la préparation.
Un curseur fait tourner la sélection, y compris les dossiers en attente, pour
qu'une correction plus loin dans la liste reste accessible.

Les commandes annulées, suspendues, archivées ou terminées ne créent aucune
demande catalogue automatique. Le filtre SQL est doublé d'une vérification locale
avant la vérification du compte et avant chaque lecture produit. Les traitements
en cours conservent leurs exclusions. L'exception de catalogue pour une correction
de prix humaine déjà enregistrée ne lève aucune annulation ni suspension.

Le registre `erplain_product_creation_reviews` conserve une empreinte de la ligne,
du mapping et du diagnostic, le nombre de passages et `next_check_at`. Un échec
transitoire attend au moins une minute, un diagnostic stable quinze minutes, avec
espacement progressif jusqu'à une heure. Une modification pertinente réveille
le dossier. Le Retry-After fournisseur reste un minimum. Une réponse 429 arrête
le passage catalogue ; le budget partagé interprocessus impose déjà la pause à
tous les connecteurs. Aucune cadence fournisseur n'est augmentée.

Les recherches simultanées identiques sont mutualisées sans cache temporel de
stock ou de document. La première réponse de découverte n'est pas relue une
seconde fois immédiatement ; la lecture précédant une création et celle qui
vérifie son résultat restent fraîches. Les différences de casse sont acceptées
pour la même référence ; la graphie fournisseur est conservée dans `erplainSku`.
Une réponse étrangère, incomplète ou plusieurs variantes restent refusées dans
la création. Aucun renommage fournisseur n'est effectué.

## Reprises

Une création de client interrompue entre dans une recherche en lecture seule avec
le numéro client immuable déjà enregistré (ou `V3:<id>`). Un résultat unique et
complet permet de conserver ce client et reprendre au checkpoint suivant. Zéro
résultat ou plusieurs résultats impose un rapprochement explicite : aucune
nouvelle création automatique n'est déduite de l'absence d'un résultat.

Les erreurs persistées de brouillon BL absent et de rapprochement BC/BL entrent
dans le sélecteur réel du worker, même sans ancien `lastError` transitoire. Les
preuves existantes de non-mouvement et de non-étiquette restent obligatoires
pour retirer localement une référence à un brouillon absent. Un BC absent est
recherché par l'identité immuable V3, jamais par son numéro seulement. Un candidat
différent est enregistré comme observation, sans rattachement ni création.

`transientRecovery` distingue `waiting`, `review_required` et `reconciled`, avec
`checkedAt`, `nextReadCheckAt`, `reconciliationError` et `actionRequired`. Une
erreur permanente n'annonce pas une reprise automatique inexistante. Le motif
courant du job remplace l'ancien incident de quota via la synchronisation existante.

Les gardes d'annulation, de stock et de documents existantes restent en vigueur.
Le passage `in_preparation` vers `ready_to_ship` reste interdit. Aucun contrôle
de quantité réservée supprimé n'est réintroduit et aucun prérequis supplémentaire
n'est ajouté à la sortie d'une étiquette après création du BL.

## Mesure après publication

Les événements `erplain.request` distinguent `erplain-catalogue-recovery`,
`erplain-catalogue-source` et la préparation normale ; la priorité reste inchangée.
`sentAt` fournit l'heure réelle précédant fetch, sans variable, secret ni identité
client. Compter les événements `response`, `provider_rate_limited` et
`network_error` comme tentatives réseau ; `local_deferred` n'est pas un appel.
Les événements GraphQL complètent le diagnostic, sans compter deux fois leur
requête HTTP. Comparer les volumes, erreurs et progression sur une même fenêtre.
Cette mesure couvre V3 ; elle ne prétend pas identifier les consommateurs externes
du compte fournisseur sans les journaux ERPLAIN correspondants.

Tests : `catalogue-demand-sql`, `missing-product-backfill`,
`missing-product-creation-contract`, `erplain-recovery-fluidity`,
`erplain-efficiency`, `temu-source-catalogue`, régressions quota/publication et
suite complète. Tests fournisseur simulés et bases isolées ; aucun test métier LIVE.
Publication et vérifications installées exclusivement par le circuit Section7.
