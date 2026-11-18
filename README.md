# Importateur des rôles d'évaluation foncière du Québec

Outil en TypeScript qui **lit, valide, nettoie et charge** dans PostgreSQL les fichiers XML des
[rôles d'évaluation foncière du Québec](https://www.donneesquebec.ca/recherche/dataset/roles-d-evaluation-fonciere-du-quebec)
(Données Québec), de façon **automatique et rejouable sans doublons**.

- Analyse des données, modèle (avec schéma) et choix : [docs/analyse.md](docs/analyse.md)
- SQL de la base : [db/migrations/001_init.sql](db/migrations/001_init.sql)

---

## En bref

```
fichier XML ──► lire (streaming) ──► valider + nettoyer ──► charger (1 transaction / fichier) ──► PostgreSQL
                                          │                          │
                                          └─► import_error           └─► import_run (journal)
```

- **Lecture en streaming** : une unité d'évaluation à la fois en mémoire. Sherbrooke (68 Mo, 56 325 unités) : ~7 s, ~100 Mo de RAM.
- **Validation selon le répertoire officiel** : champs obligatoires, types, dates, domaines de valeurs.
- **Rejouable (idempotent)** : relancer l'import donne le même résultat, sans doublons.
- **Journal complet** : chaque exécution et chaque unité rejetée sont tracées en base.
## Prérequis

- Node.js 20 ou plus
- Docker (avec Docker Compose)
## Installation

```bash
git clone <url-du-depot>
cd quebec-property-roll-importer
npm install
docker compose up -d      # démarre PostgreSQL 16 et crée les tables automatiquement
```

> La base écoute sur le port **5433** (et non 5432) pour éviter un conflit avec un PostgreSQL déjà installé.
> Connexion par défaut : `postgres://roll:roll@localhost:5433/property_roll`
> (modifiable avec la variable d'environnement `DATABASE_URL`).

## Données

Le téléchargement est hors périmètre : l'outil part de fichiers locaux. Les fichiers utilisés pour les tests :

```bash
mkdir -p data/raw/2026
cd data/raw
# Index officiel : code, nom et lien du fichier de chaque municipalité
curl -O "https://donneesouvertes.affmunqc.net/role/indexRole2026.csv"
cd 2026
for c in 01042 03015 04020 43027; do
  curl -O "https://donneesouvertes.affmunqc.net/role/RL${c}_2026.xml"
done
```

## Utilisation

```bash
# Importer un dossier (tous les .xml), avec les noms des municipalités depuis l'index
npm run import -- data/raw/2026 --index data/raw/indexRole2026.csv

# Importer des fichiers précis (--index est optionnel)
npm run import -- data/raw/2026/RL01042_2026.xml

# Forcer la réimportation d'un fichier déjà chargé
npm run import -- data/raw/2026 --force
```

Exemple de sortie :

```
Municipality names loaded from index: 1134
SUCCESS RL01042_2026.xml  read=593 loaded=593 rejected=0  233 ms
SUCCESS RL43027_2026.xml  read=56325 loaded=56325 rejected=0  7290 ms
SKIPPED RL01042_2026.xml  read=0 loaded=0 rejected=0  31 ms  -> same content already imported (run 1)
```

Le code de sortie vaut `1` si au moins un fichier a échoué : un orchestrateur (n8n, cron…) peut donc détecter l'erreur.

### Autres commandes

```bash
npm test                                   # tests unitaires (vitest)
npm run typecheck                          # vérification TypeScript
npm run profile -- data/raw/2026/*.xml     # profilage : taux de présence de chaque champ
```

## Explorer les données

Avec pgAdmin, DBeaver ou `psql` (hôte `localhost`, port `5433`, utilisateur/mot de passe `roll`) :

```sql
-- Journal des imports
SELECT id, file_name, status, units_read, units_loaded, units_rejected, error_message
FROM import_run ORDER BY id;

-- Nombre d'unités et valeur moyenne par municipalité
SELECT m.name, count(*) AS units, round(avg(p.total_value)) AS avg_value
FROM property_unit p JOIN municipality m ON m.code = p.municipality_code
GROUP BY m.name;

-- Les 10 unités les plus chères de Sherbrooke, avec adresse
SELECT p.matricule, a.number_from, a.street_name, p.construction_year, p.total_value
FROM property_unit p JOIN property_address a ON a.property_unit_id = p.id
WHERE p.municipality_code = '43027'
ORDER BY p.total_value DESC LIMIT 10;

-- Donnée d'origine complète d'une unité
SELECT matricule, jsonb_pretty(raw) FROM property_unit LIMIT 1;
```

## Structure du projet

```
├── docker-compose.yml          PostgreSQL 16 ; exécute db/migrations au premier démarrage
├── db/migrations/001_init.sql  schéma de la base
├── src/
│   ├── cli.ts                  point d'entrée : liste les fichiers et lance l'import
│   ├── parse.ts                lecture XML en streaming → une unité à la fois
│   ├── transform.ts            validation + nettoyage d'une unité (règles du répertoire)
│   ├── load.ts                 chargement : empreinte, transaction, lots, journal
│   ├── db.ts                   connexion PostgreSQL
│   └── scripts/profile.ts      outil d'analyse des données (hors import)
├── tests/                      tests unitaires
└── docs/                       analyse (avec schéma), résultat du profilage
```

## Comment l'import gère les erreurs et les relances

| Situation | Comportement |
|---|---|
| Même fichier déjà importé (même empreinte SHA-256) et toujours la version en base | `SKIPPED`, rien ne change |
| Nouveau contenu pour une municipalité/année | Remplacement complet dans **une transaction** : suppression de l'ancien contenu puis insertion |
| XML invalide ou en-tête manquant | `FAILED`, **rollback** : les données précédentes restent intactes |
| Une unité invalide | Unité ignorée et tracée dans `import_error` (position, matricule, champ, message), le reste est chargé |
| Plus de 5 % d'unités rejetées | `FAILED`, rollback : on suspecte un changement de format |
| Un fichier échoue dans un lot | Les autres fichiers sont quand même traités |

## Hypothèses, limites et sous-ensemble

Détails dans [docs/analyse.md](docs/analyse.md). En résumé :

- **Sous-ensemble utilisé** : fichiers 2026 de Grosse-Île (01042), Petite-Vallée (03015), Rivière-à-Claude (04020) et Sherbrooke (43027), soit 57 535 unités.
- Une unité est identifiée par **municipalité + année du rôle (`RLM02A`) + matricule**. L'année vient du contenu, pas du nom du fichier.
- Seuls ~20 champs utiles sont typés en colonnes ; **l'unité complète est conservée en JSONB** (`raw`).
- Les nomenclatures (codes d'utilisation CUBF, génériques de rue…) ne sont pas décodées.
- Les unités de mesure (superficie, front) ne sont pas précisées dans le répertoire : aucune conversion n'est faite.
- Pas de données géographiques (bonus non réalisé), pas de téléchargement automatique.
