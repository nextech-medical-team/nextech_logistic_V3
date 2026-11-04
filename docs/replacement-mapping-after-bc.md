# Mapping du produit de remplacement après création du BC

Avant de vérifier ou d'appliquer un remplacement, le SKU choisi doit exister
comme `target_sku` dans `mappings` pour le `channel` de la commande.
Ce contrôle concerne Amazon, Shopify, TEMU et Rakuten. Les documents Erplain
importés directement, appels d'offres et échantillons restent hors de ce
contrôle : leurs produits sont déjà exprimés en SKU Erplain sans mapping marketplace.
Une présence comme SKU source seulement, ou chez un autre gestionnaire,
ne suffit pas. Les espaces autour du SKU saisi sont retirés.

En l'absence de cette correspondance, le remplacement est bloqué avec un
message demandant de compléter le mapping. Aucun appel Erplain ni changement
du BC n'est effectué par cette tentative. Cette règle s'applique aux
remplacements ponctuels et permanents, y compris aux demandes déjà en file
lors de leur exécution.

Le contrôle lit le mapping sans l'appliquer aux lignes du BC. Le prix du
remplacement reste calculé à partir du prix de la ligne du BC remplacée et
du rapport des quantités. Les prix marketplace ne sont pas utilisés par ce
contrôle. La préparation d'un BC sans nouvelle demande de remplacement
conserve son comportement existant.
