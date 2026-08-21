# Le Jeu des Heures — Koh Lanta

Application web statique pour parier sur l'heure à laquelle Denis annonce l'épisode suivant. Multi-joueurs en direct via Supabase.

## Lancer localement

C'est un site statique pur (HTML/CSS/JS, pas de build). N'importe quel serveur statique fait l'affaire :

```bash
npx http-server -p 5173 -c-1 .
```

Puis ouvrir http://localhost:5173

## Architecture

- `index.html` — la page
- `style.css` — le style
- `app.js` — toute la logique (IIFE, vanilla JS)
- `supabase-setup.sql` — schéma initial, à exécuter une fois
- `rls-policies.sql` — politiques RLS
- `migration-all-stars.sql` — saisons, coefficients, barème et fermeture des fonctions admin

## Règles du jeu

Deviner l'heure à laquelle Denis annonce l'émission de la semaine suivante. Le plus proche **sans dépasser** l'emporte ; si tout le monde a dépassé, l'heure la plus tardive gagne.

| Situation | Points |
|---|---|
| Victoire | 1 × coefficient de l'épisode |
| Tout pile 💎 | +1 (jamais multiplié) |
| Feu sacré 🔥 — 2ᵉ victoire d'affilée | +1 (jamais multiplié) |
| Feu sacré 🔥 — 3ᵉ et au-delà | +2 (plafond) |

Coefficients : ×1 par défaut, **×2 à l'épreuve d'orientation**, **×3 en finale**. Le coefficient ne multiplie que la victoire de base — sinon un tout pile en finale vaudrait plus que la saison entière d'un bon joueur.

Départage du classement : points → victoires → tout pile → précision (écart moyen le plus faible).

Les paris ouvrent à 21h00 et se ferment à 22h00 pile (vérifié côté serveur). Chaque heure ne peut être prise que par un seul joueur, et chacun peut modifier son pari jusqu'à la fermeture.

## Saisons

Les épisodes sont numérotés **par saison** (`UNIQUE (season, number)`). Le classement est filtré sur la saison en cours, avec une bascule « Toutes saisons » pour consulter l'historique.

La saison en cours est définie par `CURRENT_SEASON` en tête de `app.js` (`SEASON_LABEL` pour l'affichage) :

- saison 1 — Koh Lanta 2026, 16 épisodes
- saison 2 — All Stars, à partir du 25 août 2026

Pour ouvrir une nouvelle saison : incrémenter `CURRENT_SEASON` et mettre à jour `SEASON_LABEL`.

## Mode admin

Ajouter `?admin=true` à l'URL et entrer le mot de passe admin lorsque demandé.

Le mot de passe n'est **pas** un simple filtre d'affichage : chaque fonction `admin_*` le revérifie en base avant d'écrire quoi que ce soit. Sans lui, aucune écriture privilégiée n'est possible, même en appelant les RPC à la main depuis la console du navigateur.

La barre admin donne accès à :

- **Épisode actif** — activer ou créer un épisode de la saison en cours
- **Coefficient** — ×1, ×2 (orientation) ou ×3 (finale). Verrouillé en base dès qu'un pari est enregistré : on ne change pas l’enjeu après l'ouverture des paris. À annoncer dans le groupe **avant 21h**.
- **Code joueurs** — code à 4 chiffres requis pour parier
- **FIN** — clôture l'épisode. Un seul appel serveur, dans une seule transaction : le serveur horodate, désigne le vainqueur et applique le barème.
- Suppression de pronostics, remise à zéro des points de la saison

## Déploiement

- **Supabase** héberge la base et les fonctions. L'URL et la clé `anon` sont en dur dans `app.js` (la clé `anon` est publique par design ; la RLS et le mot de passe admin assurent la sécurité).
- **GitHub Pages** sert les fichiers statiques depuis la branche `main` → https://adviseo.github.io/jeu-des-heures/
- Un push sur `main` suffit à publier.

## Notes de sécurité connues

- L'identité d'un joueur est son nom, saisi librement : n'importe qui peut taper le nom d'un autre et modifier son pari avant 22h. Le code à 4 chiffres protège l'accès au groupe, pas les paris individuels.
- `verify_admin_password` est appelable par `anon` (c'est le portail d'entrée du mode admin) : le mot de passe est donc testable par le réseau et doit être long et aléatoire.
- La table `predictions` est lisible publiquement : masquer les heures côté interface ne suffirait pas à faire de vrais paris à l'aveugle, il faudrait les masquer côté serveur.
