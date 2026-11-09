Amazon : départements GOFO et délais estimés
===========================================

Dans « Règles transporteurs », la section Amazon permet de renseigner :

- les départements exclus de GOFO ;
- le code postal réel de départ pour GOFO et pour GLS ;
- une grille de jours ouvrés par transporteur, départ et département destinataire.

Les réglages sont vides à l’installation. Aucun département ni délai commercial
n’est inventé. Administrateurs et gestionnaires peuvent enregistrer la grille
validée par leurs transporteurs. Les autres utilisateurs peuvent la consulter.

Le choix habituel selon le poids reste prioritaire. Pour Amazon, si ce choix
aboutit à GOFO et si le département est exclu, la nouvelle préparation utilise
GLS. Le département est déduit du code postal du BL lorsqu’une adresse de BL est
disponible, sinon de la commande. La Corse distingue 2A et 2B ; les territoires
ultramarins reconnus utilisent trois chiffres. Une destination inconnue ne
déclenche aucune exclusion. Shopify, TEMU et Appels d’offres conservent leurs
circuits. Les refus explicites de destination GOFO gardent leur reprise GLS.

Une sauvegarde des paramètres ne réaffecte aucune expédition. Les étiquettes,
suivis, créations engagées et réponses incertaines sont conservés. Les nouvelles
préparations passent par les protections habituelles avant leur affectation.

La colonne transport des commandes Amazon affiche le délai de la grille pour
le transporteur effectivement affecté, l’entrepôt sélectionné et le département.
Sans correspondance exacte : « Délai de livraison à confirmer ». Les commandes
partielles demandent une estimation par livraison plutôt qu’une promesse unique.

Un jour ouvré et deux jours ouvrés sont présentés avec les indications 24h et
48h. Ces durées restent indicatives : elles ne garantissent pas une échéance en
heures calendaires. Cette version n’invente aucune date d’arrivée et ne change
pas la promesse de livraison configurée dans Amazon Seller Central. La grille
n’est pas une réponse d’API transporteur et les statistiques GOFO ne la remplissent
pas automatiquement.

Les réglages restent dans `settings.routing` via `/api/routing` :
`gofoExcludedDepartments`, `amazonDeliveryOrigins`, `amazonDeliveryRules`.
La sauvegarde depuis un ancien écran conserve les nouvelles clés si elles ne
figurent pas dans la requête. Les champs présents sont validés côté serveur.
