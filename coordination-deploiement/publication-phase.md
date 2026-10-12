# Publication et recette distinctes

`recipe_pending` indique que le code a ete publie et verifie, mais que la recette metier reste ouverte. Cet etat demeure bloquant : il ne donne aucune priorite et ne permet pas de depasser une demande anterieure.

La commande `mark ID recipe_pending REPORT.json` exige un rapport avec `summary` et `publication` : `status: verified`, commit Git complet, `environmentHash` SHA256, `controlsRestored: true`, sauvegarde sous `/var/backups/nextech/`, et dictionnaire `files` chemin runtime vers SHA256 (null pour une suppression). Le pont serveur controle la baseline, les empreintes, les services/HTTP, l'environnement et les controles restaures avant d'enregistrer son certificat. Un certificat local ne vaut pas preuve. Un recu change exige une nouvelle verification ; un recu identique deja certifie reste historique apres une publication ulterieure.

Pour terminer, le rapport de `mark ID deployed REPORT.json` doit fournir `recipe.status: verified` et les preuves de recette dans le rapport. Aucune conversion automatique des anciennes demandes n'est effectuee. Le nouvel etat necessite le pont et la politique serveur compatibles avant utilisation ; preparer leur installation sous le verrou Section7. Cette distinction seule ne resout pas les priorites ou les recettes reellement bloquees.
