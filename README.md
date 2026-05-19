# Le Jeu des Heures — Koh Lanta

Application web statique pour parier sur l'heure à laquelle Denis annonce l'épisode suivant. Multi-joueurs en direct via Supabase.

## Lancer localement

C'est un site statique pur (HTML/CSS/JS, pas de build). N'importe quel serveur statique fait l'affaire :

```bash
npx http-server -p 5173 .
# puis ouvrir http://localhost:5173
```

## Architecture

- `index.html` — la page
- `style.css` — le style
- `app.js` — toute la logique (IIFE, vanilla JS)
- `supabase-setup.sql` — schéma à exécuter une fois dans Supabase → SQL Editor

## Mode admin

Ajouter `?admin=true` à l'URL et entrer le mot de passe admin lorsque demandé.
Donne accès au bouton FIN, gestion des épisodes, suppression de pronostics.

## Déploiement

- **Supabase** héberge la base et la fonction `verify_admin_password`. URL et clé `anon` sont en dur dans `app.js` (la clé `anon` est publique par design ; RLS — non activée pour l'instant — gérerait la sécurité plus fine).
- **Railway** sert les fichiers statiques.
- **GitHub** héberge le source ; Railway redéploie à chaque push.
