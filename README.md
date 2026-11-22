# Jamais à sec

App de Sebdesign Studio : trouver la station qui vaut vraiment le détour (gain net, trajet déduit), et voir venir les pénuries de carburant.

Application indépendante, non affiliée au gouvernement.
Données : Ministère de l'Économie et des Finances, « Prix des carburants en France », Licence Ouverte 2.0
(https://www.data.gouv.fr/datasets/prix-des-carburants-en-france-flux-instantane-v2-amelioree).

## Organisation du projet

```
donnees/                  le script qui prépare les prix (aucune dépendance à installer)
  src/index.js            télécharge le flux officiel et écrit les fichiers
  src/zip.js              ouvre le ZIP officiel
  src/lecteur.js          lit le XML station par station (prix, ruptures, fermetures)
  src/temps.js            convertit l'heure de Paris
  src/departements.js     département à partir du code postal
  src/calcul.js           gain net (autour de moi ou sur mon trajet), médiane, pépites, rupture, tendance
  src/historique.js       prix médian du jour par département, 30 jours d'historique
  src/radar.js            l'équivalent de /api/radar, pour vérifier les résultats
  test/                   tests automatiques sur un faux flux avec des cas pièges
.github/workflows/        la tâche planifiée qui tourne toutes les 15 minutes
app/                      l'application, publiée sur Cloudflare Pages (pour l'instant : la maquette)
```

## Ce que produit le script

- `site/data/index.json` : date de génération, source, et pour chaque département le nombre de stations, son emprise (pour savoir quels fichiers charger autour de l'utilisateur) et ses ruptures par carburant.
- `site/data/dep/91.json` : les stations du département 91, au format compact :

```json
{ "id": "91000001", "lat": 48.517, "lng": 2.449, "cp": "91750", "ville": "Champcueil", "adr": "Route de Milly",
  "aut": 0, "p": { "gazole": [1.76, 29400000] }, "r": { "e10": 29399000 } }
```

- `site/data/tendances.json` : le prix médian de chaque jour (30 derniers jours) par département et carburant, pour afficher « ça baisse / ça monte ». À chaque passage, le script relit l'historique déjà publié et y ajoute le jour courant.

`p` = prix (€/L) et date de mise à jour ; `r` = ruptures temporaires en cours et leur début. Les dates sont en minutes depuis 1970 (UTC).
`aut` = 1 pour une station d'autoroute. `ferm` = 1 si fermée temporairement.

Règles appliquées : stations fermées définitivement écartées ; prix de plus de 30 jours écartés ; rupture « définitive » = carburant plus vendu (ce n'est pas une pénurie) ; ruptures temporaires terminées ignorées.
Garde-fou : si le flux contient moins de 5 000 stations (flux vide ou tronqué), rien n'est publié et les anciennes données restent en ligne.

## Commandes

Depuis le dossier `donnees` :

```
node src/index.js                  télécharge le flux officiel et écrit dans ../site
node src/radar.js                  stations autour de Champcueil, gazole, 50 L au 1/4, 6 L/100
node src/radar.js --lat 48.85 --lng 2.35 --carburant e10 --rayon 10
npm test                           lance les tests
```

## Hébergement

- **Les prix** : GitHub Actions (toutes les 15 min) → GitHub Pages : https://<pseudo>.github.io/jamais-a-sec/data/
- **L'application** : Cloudflare Pages, dossier `app/`, redéployée à chaque modification du dépôt : https://jamais-a-sec.pages.dev

## Bon à savoir

- GitHub met en pause les tâches planifiées d'un dépôt public après 60 jours sans aucune modification du dépôt. Il suffit d'un commit pour les relancer.
- Mention à afficher dans l'app : la source ci-dessus, avec l'heure de la dernière mise à jour.
