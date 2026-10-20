# Publication du 19 octobre 2026 : rapprochement requis

Le run GitHub 39233055126 reprend le commit f3039f4e47ee8150075cabf60dc1168e1469755d, déjà enregistré en échec. Son premier rapport serveur signale `Conflit serveur : public/compact-problems.js`, avec `installed: false` et `paused: false`.

Le contrôle en lecture du 19 octobre confirme les services web et worker actifs, HTTPS 200 et le contenu HTTP conforme au fichier installé. La référence de publication reste 6be8285a504e9e44bad2c1627f1914752de5b712.

Plusieurs fichiers ont été publiés séparément sans actualiser cette référence. Par rapport au commit f3039f4 :

- `public/compact-problems.js`, `public/problem-corrections.js`, `src/new-bc-stock-gate.mjs`, `src/problem-resolution.mjs` et `src/publication-resume.mjs` correspondent déjà à la cible.
- `public/improvements.js` et `src/server.mjs` correspondent encore à la référence publiée : le regroupement des BL n'est pas encore installé.
- `src/erplain-live-workflow.mjs` contient la correction d9685a6 (création du BC sans contrôle bloquant du stock, contrôle conservé au BL), absente de main. Cette branche reprend ce commit avec sa documentation et ses tests afin de conserver le comportement installé.

Le rapport serveur `manual-erplain-bl-1792403819.json` documente une publication partielle de quatre fichiers de reprise des BL. Il ne certifie pas une publication complète de main.

Avant publication : fusionner la correction préservant le comportement installé, rapprocher les fichiers et la référence via Section 7 sous verrou avec preuves et sauvegardes, puis certifier la résolution de l'échec avec le mécanisme prévu. Ne pas effacer l'échec, déclarer artificiellement la restauration réussie, ni simplement remplacer les empreintes de référence pour ignorer la divergence. Le nouveau commit seul ne résout pas la divergence serveur.

Validation locale de l'intégration : tests `sales-reservations`, `publication-resume` et `recovered-delivery-display` réussis. Aucun fichier serveur ou donnée métier modifié pendant ce diagnostic.
