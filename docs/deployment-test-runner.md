# Tests pendant la publication

`npm test` conserve les groupes existants et limite chaque groupe à deux fichiers
simultanés. Les fixtures PGlite ne doivent pas dimensionner leur parallélisme à
partir du nombre de CPU de l'hôte, qui peut dépasser les ressources du build.

Chaque test dispose de cinq minutes. Le runner quitte après les résultats, même
si une fixture laisse un timer ou une connexion ouvert. Un dépassement reste un
échec : aucun test annulé ou échoué ne devient une réussite. Chaque groupe affiche
ses fichiers, son début, sa durée et son résultat dans le journal.

Les tests du lanceur vérifient un échec réel, une fixture bloquée avec timer actif,
la poursuite des groupes réussis et la limite réelle de deux processus.

Cette correction ne modifie pas le budget global du serveur ni le refus d'un
commit déjà échoué. Publier un nouveau commit corrigé et faire certifier la
résolution de l'ancienne demande par Section 7 avant la nouvelle publication.
Un succès CI ne prouve pas à lui seul que le build serveur tient dans son budget.
