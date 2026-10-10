# Règles métier poids — 10 octobre 2026

Le convertisseur commun Erplain applique 5 g par unité lorsque la valeur est absente (null, champ absent ou texte vide). Une valeur positive présente est conservée : unité explicitement kg = kilogrammes ; toute autre unité, absente ou inconnue = grammes. Les valeurs numériques invalides ou non positives restent une erreur distincte. La conversion ne modifie jamais la fiche fournisseur.

Les corrections de fiches par API sont des actions explicites : variante/SKU/produit actifs vérifiés, relecture immédiatement avant écriture, poids déjà présent préservé, journal durable avant mutation de poids seul, relecture après. Une réponse incertaine doit être rapprochée sans rejouer l’écriture. Les données et configurations de production restent hors Git.

Le diagnostic ciblé doit conserver stocks, prix, confirmations de remplacement, préparations, BC/BL, étiquettes et suivis. En particulier, une levée de diagnostic ne doit pas appeler la préparation ou relancer un achat. Tests de non-régression intégrés à npm test ; publication exclusivement par le circuit Section7.
