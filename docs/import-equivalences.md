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
