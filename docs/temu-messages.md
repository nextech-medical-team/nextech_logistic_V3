# Temu message — état de l’intégration au 21 octobre 2026

Branche de publication : `codex/temu-message`, intégrée depuis `main` au commit `1288a7e`. Le développement initial est conservé sur `feature/temu-message` avec les autres travaux locaux.

## Accès réellement vérifié

La consultation du portail officiel [Partner EU](https://partner-eu.temu.com/) et des références publiques [Partner US](https://partner-us.temu.com/documentation?menu_code=fb16b05f7a904765aac4af3a24b87d4a) n’a pas permis de confirmer une API de conversations clients. Le portail EU demande JavaScript ; les résultats publics accessibles ne documentent ni la liste des conversations, ni leur contenu, ni une réponse au dernier message client. Cette recherche **ne démontre pas que cette API n’existe pas** dans un catalogue privé ou pour d’autres autorisations.

Les [conditions officielles](https://partner.temu.com/protocol/temu_partner_platform_terms_20250523.pdf), section 6.1, subordonnent l’accès aux données aux autorisations applicables. Une autorisation de commandes ou une connexion boutique ne prouve pas l’autorisation de messagerie.

Dans ce checkout, `data` ne contient pas de `temu-production.json` ni de coffre `shops-encrypted.json`, et les variables `DATA_DIR`/`SHOP_VAULT_FILE` ne sont pas définies lors de la vérification. Les permissions privées accordées aux applications de production ne sont donc pas vérifiables ici. Aucun appel exploratoire vers un nom d’API supposé n’a été effectué. La liste blanche de `temu-api.mjs` reste inchangée.

**Blocage précis :** il manque une référence officielle applicable à la région et à l’application, le nom exact de l’API de conversations, les champs documentés (identifiant stable, client, date du dernier message client, contenu et preuve de réponse), sa pagination, ses quotas et la permission effectivement accordée à chaque boutique. Il faut vérifier ces éléments dans le compte Partner autorisé avant d’activer un collecteur. Les notifications de commandes, retours et annulations ne constituent pas des conversations.

## Comportement livré

- Entrée « Temu message », style et navigation V3, accès de consultation après authentification comme les écrans Temu existants.
- Filtres pays et réponse combinés, classement récent par défaut ou pays puis récent, pagination de 25 lignes, chargement, absence de résultats et erreurs.
- Pays issus du coffre existant et de `TEMU_COUNTRIES`, sans exposer les secrets. Aucun pays n’est déduit de l’adresse de livraison d’une commande.
- « Actualiser » réservé aux rôles admin/manager/operator. Réutilise `connectTemuShops` et le client existant, donc sa signature, son budget API et son relais. Les vérifications concurrentes sont regroupées et espacées d’au moins une minute par processus ; le budget API partagé reste applicable aux appels réseau.
- État bloqué explicite et HTTP 409 à l’actualisation. Une connexion vérifiée signifie uniquement que l’identité boutique est accessible. Date de vérification persistée ; dernière synchronisation des messages = « Jamais » tant que le collecteur est absent. Aucun message réel n’est prétendu récupéré.
- Stockage séparé, clé unique `(shop_id, conversation_id)`, protection contre une observation plus ancienne, détail uniquement si contenu présent. Aucun endpoint d’écriture ou d’envoi de message client.

`storeTemuConversation` définit un **contrat interne V3**, pas des champs Temu. Il n’est appelé par aucune route ni synchronisation active. Il prépare le stockage et les tests pour un futur adaptateur documenté. `answered` ne devient Répondu/Non répondu qu’avec une preuve explicite relative au dernier message client ; sinon Inconnu, y compris si un indicateur « lu » existe. Les exemples des tests sont synthétiques et ne sont jamais chargés dans l’application. Le collecteur réel, le mapping officiel, les quotas propres à la messagerie et la restitution structurée de son contenu restent bloqués.

## Validation

`node --test test/temu-messages.test.mjs` teste les filtres combinés, le tri par pays puis date, l’isolation des identifiants entre boutiques, les doublons, les observations anciennes, la réinitialisation après nouveau message client, les statuts inconnus, la pagination, la validation des filtres, les permissions d’actualisation et l’état bloqué sans fuite de secrets.

Résultats : 21 tests passent en incluant `test/temu-shop-clients.test.mjs`. `node scripts/check-syntax.mjs` valide 665 fichiers JavaScript. Vérification navigateur Chrome sans interface sur la fixture UI isolée, en 1440 et 390 pixels : menu, filtres combinés, état vide, dernière synchronisation « Jamais », actualisation bloquée et erreur HTTP 503 ; aucune erreur JavaScript. Captures locales : `tmp/temu-messages-1440.png` et `tmp/temu-messages-390.png`. La suite globale de tests métier n’a pas été exécutée. Aucun test de récupération réelle de conversations n’est possible sans l’accès documenté.

## Test avec les accès serveur, après la première vérification

À la demande de l’utilisateur, connexion SSH au serveur confirmé `141.94.220.64`, avec contrôle de l’empreinte existante. La configuration principale Temu a été copiée depuis le stockage privé serveur vers `data/temu-production.json`, exclu de Git. Les droits du fichier sont limités au compte Windows courant. Aucun autre jeton de pays n’a été copié ; aucun service ou accès serveur n’a été modifié. Association locale de cette connexion à FR pour le test demandé ; l’API retourne un identifiant de site, sans libellé de pays : cette association locale n’est pas présentée comme un libellé pays renvoyé par Temu.

- Depuis le poste local : `bg.open.accesstoken.info.get` refuse l’appel avec `5000003`, correspondant au refus d’IP prévu par le client existant. L’ajout du fichier ne suffit donc pas à rendre les appels directs locaux opérationnels.
- Depuis le serveur : `bg.open.accesstoken.info.get` et `bg.local.mall.info.get` réussissent (`success=true`, `errorCode=1000000`). Le jeton n’est donc pas invalidé par ce test local refusé.
- La réponse réelle d’autorisation contient `apiScopeList`. La liste consultée comprend les commandes, produits, livraisons, retours, publicités et `bg.tmc.message.update`. Aucune API identifiée de consultation des conversations clients ou du statut de réponse n’y figure. Le seul nom contenant « message » ne constitue pas une preuve d’accès aux conversations ; il n’a pas été appelé et aucune souscription n’a été modifiée.
- Aucun message client n’a été récupéré, créé ou envoyé. Les secrets et le mot de passe SSH ne figurent ni dans ce rapport ni dans les sources suivies.

Prochaine condition pour des appels directs locaux : autoriser l’IP publique du poste dans la configuration Temu de l’application, ou utiliser un relais en lecture seule explicitement configuré. Cela ne résout pas à lui seul l’absence d’accès confirmé aux conversations.

## Correction du chargement du design

La capture sans mise en page provenait de la CSP réelle (`style-src 'self'`), qui refuse la balise style injectée par le module. Les styles sont désormais dans `public/style.css`, déjà servie par l’application, avec version de cache actualisée dans la page. Aucun assouplissement de la CSP ni redémarrage du serveur local nécessaire. Le style du contenu de conversation a également été sorti de son attribut inline.

Ajout de `test/ui/temu-messages.spec.mjs` : rendu ordinateur/mobile sous la CSP de production, contrôle des styles calculés, filtres, absence de débordement et masquage des blocs hors sujet. Les vérifications navigateur de chargement, filtres, actualisation bloquée et erreur passent également sous cette CSP. Vérification du serveur local sur le port 4317 : la feuille CSS répond HTTP 200 et contient les styles du module.

## Statistique des non répondus

Carte « Non répondus » : nombre de conversations dont le dernier message client est explicitement non répondu, pour le pays sélectionné, sur toutes les pages. Le filtre Réponse ne change pas ce compteur ; les statuts inconnus sont exclus. Le bouton « Voir les non répondus » applique le filtre correspondant en conservant le pays. Tant que l’accès aux conversations n’est pas confirmé, ou en cas d’erreur de chargement, affichage « Indisponible » et bouton désactivé, sans prétendre que le nombre réel est zéro. Tests SQL sur pays, filtre de réponse et pagination.

## Actualisation automatique

L’écran relit les données locales et ses statistiques chaque minute, sans modifier les filtres ni la page et sans vider le tableau pendant la lecture. Pause lorsque l’onglet est masqué, une autre vue est ouverte, la session est fermée, une lecture est déjà en cours ou une conversation est ouverte. Lecture immédiate au retour dans un onglet visible. Le pied de page indique l’heure de la dernière lecture de l’écran, distincte de la dernière synchronisation des messages.

Cette actualisation n’envoie aucun POST automatique et ne déclenche pas d’appel exploratoire à Temu. Le collecteur reste bloqué par l’absence d’API de conversations confirmée. Tests navigateur : intervalle simulé, conservation pays/réponse, arrêt hors de la vue, absence de POST. Trois tests navigateur passent, dont les rendus sous CSP en ordinateur et mobile.

## Vérification d’intégration avant publication GitHub

`test/temu-messages-startup.test.mjs` démarre le vrai serveur V3 avec une base temporaire, sans accès fournisseur et sans traitements de fond. Il vérifie la page, les ressources statiques, l’authentification, le module sans configuration Temu, le refus explicite d’actualisation et l’accès aux commandes, au tableau de bord et au compte après ce refus. Résultat : réussi.

Cinq tests navigateur du module réussissent sur le dernier `main`, dont deux tests confirmant le retour aux commandes après une erreur HTTP 503 des messages en ordinateur et mobile. Les 21 contrôles existants de disposition, stabilité et adaptation des commandes ont aussi été vérifiés ; seuls les chemins de sortie des captures des copies de test locales ont été adaptés à Windows. Le module conserve la CSP existante et n’installe aucun collecteur de messages ni appel fournisseur au démarrage. Les fichiers privés locaux ne font pas partie du commit.
