# TEMU : un colis
Décision humaine du 11 octobre : toute nouvelle commande TEMU et toute modification du nombre de colis TEMU sont enregistrées avec un colis. La migration installe un trigger PostgreSQL/PGlite avant que openDatabase rende la base aux services. Les imports et reprises qui écrivent NULL sont donc couverts.

La correction historique autorisée porte sur les 21 commandes actives auditées avec poids positif et nombre de colis NULL. Aucun poids, PDF, suivi, achat, stock ou document Erplain ne change. Les anciennes valeurs positives sont préservées tant qu’elles ne font pas l’objet d’une nouvelle modification du champ.

Après correction, seul le message historique exact « Poids ou nombre de colis absent » est requalifié si le poids est positif et le nombre vaut un. La revue métier reste ouverte, aucun achat ni reprise de création n’est déclenché. Les nouveaux messages distinguent le poids du nombre de colis.
