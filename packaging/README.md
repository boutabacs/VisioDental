# Serveur de cabinet VisioDental — paquet Windows

Ce dossier construit installateur **serveur** : PostgreSQL, API Express et
interface Nuxt sur le PC du cabinet, accessibles depuis les autres postes en
navigateur. Le client de poste (fenêtre dédiée) est prévu dans un second temps.

## Construire le paquet

Depuis la racine du dépôt :

```powershell
npm run build:prod          # API + site + runtime
npm run build:prod -- --fresh   # réinstalle aussi les dépendances API
```

Résultat dans `dist-server/` :

```
dist-server/
  api/                  API compilée (dist/), schéma Prisma, modules de production
  site/.output/         serveur Nuxt (preset node-server)
  runtime/node.exe      Node embarqué
  runtime/start.mjs     superviseur (API puis site, redémarrage automatique)
  runtime/backup.ps1    sauvegarde quotidienne
  VisioDental.xml       service Windows de l'application
  VisioDentalPostgres.xml
  server.env.example    modèle de configuration
  install-server.ps1    installeur
  uninstall-server.ps1  désinstalleur
  VERSION
```

Le paquet peut être livré tel quel (dossier zippé) : `install-server.ps1`
se lance depuis le dossier.

**Installation hors ligne** : posez les binaires à côté de l'installeur avant
de lancer la copie sur le serveur —

- `postgresql-16.9-1-windows-x64-binaries.zip` (archive EDB) : utilisée à la
  place du téléchargement ;
- `runtime\winsw.exe` (WinSW.NET4.exe renommé) : copié au lieu d'être
  téléchargé depuis GitHub.

Sans ces fichiers, l'installeur télécharge les deux (accès Internet requis
sur le poste serveur au moment de l'installation).

## Installer dans le cabinet

1. Copier `dist-server/` sur le PC serveur (Windows 10/11, droits admin).
2. Clic droit sur `install-server.ps1` → **Exécuter avec PowerShell**, ou :

   ```powershell
   powershell -ExecutionPolicy Bypass -File install-server.ps1
   ```

3. Le script :
   - copie le programme dans `C:\Program Files\VisioDental` ;
   - télécharge PostgreSQL 16 portable (~300 Mo) et WinSW si absents ;
   - génère `.env` (mot de passe base, `SECRET_KEY`) et le port PostgreSQL ;
   - initialise le cluster, crée le rôle et la base ;
   - applique le schéma (`prisma db push`) et les données structurelles ;
   - installe les services **VisioDental PostgreSQL** et **VisioDental Server** ;
   - ouvre le port du site (profil réseau privé) et planifie la sauvegarde
     quotidienne à 22 h 30 ;
   - ouvre `http://localhost:3000/setup`.

4. Terminer l'assistant `/setup` : clinique, administrateur, premier fauteuil.

Les autres postes ouvrent `http://<IP-du-serveur>:3000`. Le pare-feu doit
autoriser le réseau **privé** ; l'API (port 8100) n'est jamais exposée.

### Options utiles

| Option | Effet |
| --- | --- |
| `-InstallDir "D:\VisioDental"` | change le dossier cible |
| `-SitePort 3080` | change le port du site |
| `-PostgresPort 5433` | impose le port PostgreSQL (auto si 5432 occupé) |
| `-SkipPostgres -ExistingDatabaseUrl "postgresql://..."` | base déjà hébergée |
| `-NoLaunch` | ne pas ouvrir le navigateur |

La réexécution du script met à jour le programme en conservant `.env`,
`data\`, `backups\` et `logs\`.

## Exploitation

- **Journaux** : `C:\Program Files\VisioDental\logs`.
- **Services** : `services.msc` → `VisioDental Server`, `VisioDental PostgreSQL`.
- **Sauvegardes** : `backups\visiodental-AAAAMMJJ-HHmm.dump` (14 conservées),
  tâche planifiée `VisioDental Backup`.
- **Restauration** :

  ```powershell
  & "C:\Program Files\VisioDental\pgsql\bin\pg_restore.exe" `
     -h 127.0.0.1 -U visiodental -d visiodental --clean --if-exists `
     "C:\Program Files\VisioDental\backups\visiodental-20260101-2230.dump"
  ```

  Arrêter le service `VisioDental Server` pendant la restauration.

- **Désinstallation** : `uninstall-server.ps1` (les données sont conservées par
  défaut ; `-RemoveDatabase` les supprime).

## Sécurité et limites connues

- Le site est servi en **HTTP** sur le réseau local, donc `COOKIE_SECURE=false`
  dans `.env`. Les données circulent en clair sur le LAN : à réserver à un
  réseau de cabinet maîtrisé. Une variante HTTPS (certificat auto-signé
  installé sur les postes) est l'étape de durcissement suivante.
- PostgreSQL n'écoute qu'en boucle locale (`127.0.0.1`) et n'est pas ouvert au
  pare-feu.
- L'installeur n'est pas encore signé : SmartScreen affichera un avertissement
  au premier lancement. Prévoir un certificat de signature avant diffusion.
- Les clés Copilot / SMTP se renseignent ensuite dans `.env` puis redémarrent
  le service.

## Dépannage

| Symptôme | Piste |
| --- | --- |
| `502 Bad Gateway` sur `/api/v1/...` | L'API n'est pas prête ou a planté : consulter `logs\VisioDental.*.log`. Le site attend `/health` avant de démarrer. |
| Page inaccessible depuis un poste | Vérifier l'IP (`ipconfig` sur le serveur), le profil réseau **privé** et la règle de pare-feu « VisioDental (site) ». |
| `Could not connect to server` côté API | Service `VisioDental PostgreSQL` arrêté ou port différent : comparer `DATABASE_URL` dans `.env` et le port de `pgsql\data\pg\postgresql.conf`. |
| Mot de passe administrateur perdu | Aucune réinitialisation en ligne de commande pour l'instant : restaurer une sauvegarde `backups\visiodental-*.dump` ou contacter le support VisioDental. |
| Réinitialiser l'assistant `/setup` | Il ne s'ouvre que si aucun utilisateur n'existe. Créer/nettoyer les utilisateurs en base si nécessaire. |

Le journal du superviseur préfixe chaque ligne par `[api]` ou `[site]`, ce qui
permet de distinguer les erreurs des deux processus.
