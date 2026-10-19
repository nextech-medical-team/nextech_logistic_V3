# Suite d'une livraison partielle TEMU

Le worker ne termine plus silencieusement au statut `bl_only`. Le branchement
installé par le serveur poursuit les deux étapes indépendantes suivantes :

* finaliser uniquement le statut du BL déjà créé, après lecture ERPLAIN fraîche ;
* récupérer son étiquette TEMU existante ou présenter le devis de sa sélection.

Le passage à `ready_to_ship` est idempotent depuis `pending` ou
`make_the_shipment`. `in_preparation` reste strictement interdit et une source
inconnue ne permet aucune mutation. Aucun BC, ligne ou stock n'est modifié pour
finaliser le statut. Les éditions d'étiquettes existantes sont conservées avant
le changement de contexte. Une difficulté sur le statut est affichée séparément
et n'empêche pas l'étape étiquette. Un BL observé annulé ou expédié empêche tout
nouvel achat.

Le devis ne contient que les unités de vente TEMU de la sélection partielle,
avec conversion depuis l'allocation enregistrée (une boîte peut représenter
plusieurs unités Erplain). Une identité ambiguë ou une fraction de boîte non
représentable produit un motif explicite ; le reliquat n'est jamais ajouté.
Les expéditions fournisseur sont rapprochées avant devis et achat. Les colis
affectés aux autres livraisons sont exclus. Un chevauchement, un résultat
incomplet ou une tentative incertaine empêche un nouvel achat.

La confirmation explicite du montant reste nécessaire, comme dans le parcours
manuel TEMU existant. Le plan et l'identité de la livraison sont relus avant la
prise atomique de tentative. L'identifiant de tentative est persisté avant
l'appel fournisseur. Un timeout, une interruption ou un résultat inexploitable
ne remet jamais l'achat à zéro : seule la récupération du colis est permise.
Les PDF fournisseur sont stockés inchangés dans `partial_documents` et ne sont
pas retéléchargés lorsqu'ils existent déjà. Aucun transporteur direct de repli
n'est utilisé. Le parcours TEMU de la commande entière refuse désormais aussi
une commande en mode partiel sans BL global, pour prévenir un achat du reliquat.

La colonne additive `partial_deliveries.temu_label` contient le plan, la
tentative, les colis, le prochain contrôle et l'éventuel problème de statut BL.
`temu_wait` est repris automatiquement au délai enregistré ; `temu_confirm`
présente le montant à confirmer ; `ready` exige PDF, suivi et statut BL prêt.
`temu_ready_review` conserve le PDF mais distingue le statut BL non finalisé.
L'historique et les boutons d'étiquette sont accessibles même lorsque la
vérification de stock d'une nouvelle préparation est lente ou indisponible.

Publication exclusivement Section7, après PR235 et vérification des empreintes
actuelles. Ne pas publier une ancienne copie globale de `partial-deliveries.mjs`
ou du runner. Retour arrière ciblé des sources ; conserver la colonne, les
tentatives et les documents. Avant retour arrière, rapprocher les états
`temu_wait`, `temu_confirm` et `temu_ready_review` : l'ancien worker ne les traite
pas. Ne jamais les remettre globalement en file ni réacheter pour tester.

Validation : `test/partial-temu-label.test.mjs`, régressions BL partiels,
transition ERPLAIN interdite et achats TEMU ; navigateur ordinateur/mobile avec
lecture de stock volontairement en attente, devis, confirmation unique et PDF.
Tous les appels fournisseur de ces tests sont simulés.
