# Importer des équivalences

Dans **Paramètres → Importer des équivalences**, un administrateur ou responsable peut importer un fichier XLSX contenant **Onglet type**, avec ces quatre colonnes :

| Numéro de commande | SKU de base | SKU de remplacement | Qté de remplacement |
| --- | --- | --- | --- |
| #EXEMPLE | BASE-001 | ALTERNATIVE-001 | 100 |

L’analyse lit les commandes Amazon, Shopify et TEMU ainsi que leur BC et le stock réel Erplain. Les AO sont exclus. La quantité de base à remplacer est celle de la ligne actuelle du BC ; la quantité du nouveau produit vient du fichier.

Toutes les lignes applicables sont cochées par défaut. L’utilisateur peut en décocher, tout cocher ou tout décocher. **Appliquer la sélection et reprendre les commandes** confirme les remplacements limités à ces commandes, sans changer les mappings permanents.

Le stock est contrôlé par produit et emplacement sur toute la sélection, y compris les autres imports confirmés. Il est relu avant chaque enregistrement. Un produit inactif, un BC absent, une référence ambiguë, un stock insuffisant ou une commande protégée produit un motif précis ; aucune quantité fictive n’est ajoutée.

Plusieurs produits d’une même commande sont remplacés successivement. La préparation attend le dernier produit sélectionné avant de reprendre le contrôle du stock, du BL et des étiquettes dans le circuit habituel. Les nouvelles étiquettes TEMU restent dans le parcours TEMU. Les documents existants et les créations incertaines conservent les protections du moteur de remplacement.

L’historique permet de retrouver un import après rechargement. Les résultats distinguent les lignes décochées, déjà appliquées, en cours, vérifiées et bloquées. Un double clic sur la même sélection ne crée pas une seconde demande. Un résultat externe incertain bloque la reprise et exige un rapprochement, sans nouvelle tentative automatique.

Les livraisons partielles et BC historiques conservent leurs contrôles particuliers. Plusieurs remplacements sur une même livraison partielle ou historique, ainsi que les remplacements en chaîne (A→B puis B→C), nécessitent un rapprochement et ne sont pas appliqués en lot.

Les tests de recette utilisent des commandes et fournisseurs simulés ; aucun fichier métier n’est appliqué à des commandes réelles pour vérifier la publication.
# Modèle et export des ruptures

Dans Importer des équivalences, **Télécharger le modèle Excel** fournit un XLSX vierge compatible avec le format actuel. **Exporter les ruptures et équivalents** examine en lecture seule les commandes Amazon, Shopify et TEMU non archivées et non expédiées, leurs BC actuels et les références d’équivalence actives. La vérification s’effectue en arrière-plan ; le navigateur télécharge le résultat à sa fin. Les exports sont privés au compte demandeur et expirent après 30 minutes (ou un redémarrage).

Les BC sont lus par groupes de dix avec le quota partagé Erplain inchangé. Une réponse GraphQL partielle est traitée par commande : les BC voisins valides restent exportables. L’écran indique la phase, les commandes examinées, les ruptures et le temps écoulé ; après quinze secondes sans progression, il signale une attente possible de réponse Erplain ou du quota. Recliquer avec le même compte pendant un export permet de rejoindre le traitement en cours sans le dupliquer. Les stocks des équivalents restent lus une seule fois par SKU et par export.

L’onglet **Onglet type** contient une ligne par commande/SKU en stock insuffisant, avec la quantité entière à remplacer selon le BC. Le SKU de remplacement reste vide pour permettre un choix humain. L’onglet **Équivalents proposés** présente toutes les correspondances directes actives et réciproques, avec le stock vérifié à l’emplacement de préparation. Le stock suffisant pour une ligne ne garantit pas le stock cumulé pour plusieurs commandes.

Compléter les SKU de remplacement, retirer les lignes non retenues, puis analyser le fichier. Conserver les numéros de commande et SKU au format texte. **Contrôles** précise les exclusions (suspensions, livraisons existantes ou partielles) et les commandes non vérifiables (BC absent, réponse ou stock incomplet, API indisponible). Aucun résultat incomplet ne constitue une preuve de couverture complète. Au-delà de 1 000 lignes en rupture, l’export échoue explicitement sans tronquer, conformément à la limite de l’import actuel. Aucun téléchargement ne modifie les commandes, les stocks, les références ou les documents ; seuls les contrôles et la validation habituels de l’import permettent ensuite d’appliquer les choix.

