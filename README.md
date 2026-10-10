# NEXTECH LOGISTIC V3

Sources de l'application actuellement publiÃ©e, rÃ©cupÃ©rÃ©es le 10 octobre 2026 et vÃ©rifiÃ©es par empreintes SHA-256 contre le serveur.

Le dossier `src/` contient le backend et les connecteurs ; `public/` contient l'interface. Node.js 24 ou supÃ©rieur est requis. Installation des dÃ©pendances : `npm ci`. DÃ©marrage : `npm start`, aprÃ¨s configuration d'un environnement isolÃ© appropriÃ©.

Les bases de donnÃ©es, documents, Ã©tiquettes, journaux et identifiants de production sont volontairement exclus. Ne jamais connecter un environnement de dÃ©veloppement aux services mÃ©tier rÃ©els sans autorisation spÃ©cifique.

Le serveur publiÃ© ne contient pas les dossiers `scripts/` et `test/`. Les commandes `npm test` et `npm run check` du package d'origine rÃ©fÃ©rencent des scripts absents de cet export. Les vÃ©rifications syntaxiques ont Ã©tÃ© exÃ©cutÃ©es sÃ©parÃ©ment ; cet export ne constitue pas une validation fonctionnelle complÃ¨te.

La publication GitHub ne dÃ©clenche pas de dÃ©ploiement serveur. Les publications et redÃ©marrages V3 restent exclusivement centralisÃ©s par la Section 7 via la file commune du projet.

Les instantanÃ©s mÃ©tier margin-published-snapshot.json et temu-reading-reports.json sont exclus. Le pÃ©rimÃ¨tre privÃ© de rÃ©import TEMU est vide dans cette copie : aucun rÃ©import de ce lot ne peut Ãªtre autorisÃ© par cette copie. Le service de marges nÃ©cessite son fichier de configuration privÃ© pour dÃ©marrer. Ces exclusions concernent seulement le dÃ©pÃ´t public ; le serveur reste inchangÃ©.
Les identifiants privÃ©s du lot cancelled-import-reimport sont aussi retirÃ©s ; ce lot reste dÃ©sactivÃ© dans la copie publique.
