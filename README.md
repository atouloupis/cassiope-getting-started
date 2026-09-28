# Cassiope · Getting started

Petit service Node.js (2 dépendances, image d'environ 60 Mo, build en quelques secondes) qui permet de
tester en un seul endroit ce que fait [Cassiope](https://cassiope.eu) : variables d'environnement,
add-ons, connexions internes et stockage. Une page web unique, en français.

| Section | Ce qu'elle teste |
|---|---|
| **Variables** | Les variables ajoutées au service sont-elles injectées ? Les secrets sont masqués (2 premiers caractères + longueur). |
| **Add-ons** | Toute variable contenant une URL `postgres://` ou `redis://` est détectée (ou un groupe `X_HOST`/`X_PORT`/`X_USER`/`X_PASSWORD`/`X_DATABASE`). Le test se connecte, écrit et relit une donnée ; un binding en lecture seule est signalé. |
| **Connexion interne** | Les variables `{PRÉFIXE}_URL` / `_HOST` / `_PORT` d'un lien interne sont détectées ; le test appelle `/api/whoami` (ou le chemin de votre choix) sur l'autre service. |
| **Stockage** | Compare le disque applicatif (`/app/scratch`, éphémère) et `/data`. Indique si un volume est réellement monté, l'usage disque, et un compteur de démarrages qui ne survit à un redéploiement que sur un volume. |

## Parcours de test dans Cassiope

1. Créez un service depuis l'image `ghcr.io/atouloupis/cassiope-getting-started:latest` (port `3000`) ou depuis ce dépôt Git (build Dockerfile).
2. **Variables** : ajoutez `HELLO=world` et une variable secrète, redéployez, vérifiez-les dans la section 1.
3. **Add-ons** : créez un add-on PostgreSQL et un Redis, attachez-les au service (bindings), redéployez, cliquez « Tester ».
4. **Connexion interne** : déployez une seconde copie, exposez-la à une adresse interne, connectez la première à la seconde, redéployez, cliquez « Tester ».
5. **Stockage** : notez le compteur de démarrages, redéployez (il retombe à 1 sans volume). Ajoutez un volume persistant monté sur `/data`, redéployez deux fois : le compteur de `/data` s'incrémente.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `APP_NAME` | nom d'hôte | Nom affiché, utile pour distinguer deux copies |
| `DATA_DIR` | `/data` | Dossier où monter le volume persistant |
| `SCRATCH_DIR` | `/app/scratch` | Dossier sur le disque applicatif |

Sonde de santé : `GET /healthz` (`wget -q -O /dev/null http://127.0.0.1:3000/healthz`).

## En local

```sh
npm install && npm start        # http://localhost:3000
docker build -t cassiope-getting-started . && docker run --rm -p 3000:3000 cassiope-getting-started
```

## Sécurité

Outil de démonstration : à ne pas laisser exposé publiquement avec de vrais secrets. Les valeurs
sensibles sont masquées, les tests réseau ne ciblent que des adresses issues de l'environnement (jamais
saisies par le visiteur), et les écritures se limitent à la table `cassiope_probe` (20 lignes max), aux
clés Redis `cassiope-probe:*` et à des fichiers `probe-*.bin` de 100 Mo max. Le conteneur tourne en root
pour pouvoir écrire dans un volume fraîchement monté.

## Licence

MIT
