# Reprise d’un BC enregistré mais absent d’Erplain

La fenêtre des problèmes BC, réponse incomplète ou diagnostic non classé propose « Vérifier le BC absent et reprendre ». L’opérateur doit confirmer la référence de commande. Le numéro visible du BC ne sert jamais à rattacher un document : un autre client peut porter ce numéro dans Erplain.

La reprise est limitée aux commandes TEMU/Amazon non importées, non partielles et non expédiées, dont le traitement V3 est encore à `bc_created`, avec un BC en brouillon (ou un statut local non renseigné), sans BL ni tentative de stock enregistrés. Les traitements concurrents sont bloquants.

Avant de retirer le pointeur local, V3 vérifie :

- une réponse explicite `Order: null` pour l’ancien identifiant ; une erreur ou une réponse partielle n’est pas une preuve d’absence ;
- l’absence de candidat portant la référence ou l’identité V3, y compris les cas annulés ou ambigus ;
- l’identité du client enregistré ;
- la liste paginée des BL, leurs commandes associées et références ;
- les sorties de stock identifiées par les deux conventions V3 ;
- le journal stock depuis la réception de cette commande non importée (ou la date de création du BC si elle est antérieure), avec une journée de marge ; tout mouvement du BC interdit la reprise.

Les lectures paginées sont bornées à 200 pages par collection. Une recherche incomplète, un quota API ou un historique trop volumineux conservent le blocage. L’identifiant et la référence du BC sont relus après les recherches. La commande est ensuite verrouillée et comparée à l’état initial avant enregistrement.

L’état ERP précédent et le diagnostic sont archivés dans `erp_live.missingBcRecovery` et dans l’audit `erplain.missing_bc_retry_authorized`. La préparation repart à `customer_created` ; les prix, sources, quantités, adresses et stocks sont recontrôlés par le circuit normal. Cette fonction ne fait aucune mutation externe et ne modifie ni les fichiers PDF, ni les achats TEMU, ni le suivi. La continuation est limitée à la préparation ERP.

Un BC retrouvé, un client non confirmé, un BL ou mouvement existant exige un rapprochement : le bouton ne force pas ces cas. La réussite des tests locaux ne prouve pas que les commandes de production satisfont ces conditions.
