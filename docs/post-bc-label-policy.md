# BL et étiquettes après création du BDC

Décision humaine du 13 octobre 2026 : dès qu'un BDC est enregistré dans Erplain, V3 lit son contenu pour préparer les BL et les étiquettes. Les données commerciales V3, les plateformes et les mappings globaux ne servent plus à remettre en cause ce document.

Après persistance du BDC, aucune comparaison des prix, totaux, TVA, base HT/TTC, remises, écotaxes ou quantités avec une source commerciale n'est une condition de préparation. Les champs commerciaux absents sont observés comme absents, sans montant inventé. Le calcul du poids, lorsqu'il est disponible, utilise les quantités du BDC enregistré.

La politique s'applique à tous les canaux, aux BDC existants, retrouvés après une réponse perdue, nouvellement créés et repris, ainsi qu'aux consultations de livraisons partielles et aux admissions d'étiquettes. Elle n'autorise ni modification rétroactive du BDC commercial, ni annulation, ni nouvelle émission d'un document existant.

Les gardes d'identité et de relation des documents, de non-duplication, de stock et d'écritures incertaines restent applicables. L'interdiction Erplain `in_preparation` vers `ready_to_ship`, le circuit TEMU obligatoire, les suspensions des imports API et des achats restent inchangés. Les informations nécessaires à une opération réelle doivent être reçues ; V3 ne les invente pas.

Les anciens contrôles commerciaux reconnus sont retirés par `retirePostBcCommercialControls`, avec une relecture du BDC, une transaction locale et une trace d'audit. Les jobs de reprise antérieurs restent dans l'historique, avec un marqueur de retrait de contrôle ; ils ne sont pas déclarés exécutés. Les erreurs mixtes, de transport, de stock ou d'écriture incertaine sont conservées. La reprise utilise le worker ERP existant, sans achat TEMU forcé ni nouvelle requête d'étiquette par ce retrait.

La publication reste manuelle par Section7. Une préparation ou une PR ne prouve pas que le code est installé ni que la commande est terminée. La recette après publication doit vérifier la version installée, le retrait du motif commercial, puis l'état réel du BL et de l'étiquette, en conservant tout autre blocage actuel.
