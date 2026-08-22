# Le Jeu des Heures — Koh Lanta

Application web statique pour parier sur l'heure à laquelle Denis annonce l'épisode suivant. Multi-joueurs en direct via Supabase.

C'est **la seule** implémentation du Jeu des Heures : un bot Discord tenait autrefois un classement parallèle, il a été retiré.

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

Coefficients : ×1 par défaut, **×2 à l'épreuve d'orientation**, **×3 à la finale**. Le coefficient ne multiplie que la victoire de base — sinon un tout pile en finale vaudrait plus que la saison entière d'un bon joueur. Il est annoncé avant 21h et se verrouille dès le premier pari. Si orientation et poteaux tombent le même soir, seul le dernier épisode compte ×3.

**Le soir de la finale**, il n'y a pas d'épisode suivant à annoncer : on parie sur le moment où Denis prononce le nom du vainqueur.

Départage du classement : points → victoires → tout pile → précision (écart moyen le plus faible, calculé sur **tous** les paris et pas seulement les victoires).

**Référence horaire : le direct TF1+.** C'est l'heure de l'annonce sur TF1+ qui fait foi, pas celle de la TNT — les deux flux ne sont pas synchrones, et l'écart peut atteindre la minute. La saison 1 a été mesurée sur la TNT : le repère historique affiché dans le formulaire porte donc un léger biais systématique tant que la saison 2 n'a pas assez d'épisodes pour parler d'elle-même.

Les paris ouvrent à 21h00 et se ferment à **21h30** pile (vérifié côté serveur). La fenêtre est courte volontairement : la saison passée, la médiane des paris était à 21:09 et personne n'a jamais parié après 21:44 — le dernier quart d'heure ne servait qu'à attendre que les autres se découvrent. Pour la changer, il faut la modifier à deux endroits : `BET_WINDOW_END` dans `app.js` et le trigger `check_bet_window` en base. Chaque heure ne peut être prise que par un seul joueur, et chacun peut modifier son pari jusqu'à la fermeture.

## Saisons

Les épisodes sont numérotés **par saison** (`UNIQUE (season, number)`). Le classement est filtré sur la saison en cours, avec une bascule « Toutes saisons » pour consulter l'historique.

La saison en cours est définie par `CURRENT_SEASON` en tête de `app.js` (`SEASON_LABEL` pour l'affichage) :

- saison 1 — Koh Lanta 2026, 16 épisodes
- saison 2 — All Stars, à partir du 25 août 2026

Pour ouvrir une nouvelle saison : incrémenter `CURRENT_SEASON` et mettre à jour `SEASON_LABEL`.

## Mode admin

Ajouter `?admin=true` à l'URL et entrer le mot de passe admin lorsque demandé.

Le mot de passe n'est **pas** un simple filtre d'affichage : chaque fonction `admin_*` le revérifie en base avant d'écrire quoi que ce soit. Sans lui, aucune écriture privilégiée n'est possible, même en appelant les RPC à la main depuis la console du navigateur.

Il est stocké haché (bcrypt) dans `app_secrets`, une table dont la RLS est activée sans aucune politique : seules les fonctions `SECURITY DEFINER` y accèdent. Pour le changer, dans Supabase → SQL Editor :

```sql
INSERT INTO public.app_secrets (key, value)
VALUES ('admin_pw_hash',
        extensions.crypt('VOTRE-NOUVEAU-MOT-DE-PASSE', extensions.gen_salt('bf', 10)))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

Tant qu'aucun hash n'est enregistré, `verify_admin_password` retombe sur l'ancienne implémentation (`verify_admin_password_legacy`), ce qui évite toute coupure d'accès. Une fois le hash posé et l'accès vérifié, supprimez cette fonction de repli — elle contient encore un mot de passe en clair :

```sql
DROP FUNCTION public.verify_admin_password_legacy(text);
```

La barre admin donne accès à :

- **Épisode actif** — activer ou créer un épisode de la saison en cours
- **Coefficient** — ×1, ×2 (orientation) ou ×3 (finale). Verrouillé en base dès qu'un pari est enregistré : on ne change pas l’enjeu après l'ouverture des paris. À annoncer dans le groupe **avant 21h**.
- **Code joueurs** — code à 4 chiffres requis pour parier
- **FIN** — clôture l'épisode. Un seul appel serveur, dans une seule transaction : le serveur horodate, désigne le vainqueur et applique le barème.
- Suppression de pronostics, remise à zéro des points de la saison

## Déploiement

- **Supabase** héberge la base et les fonctions. L'URL et la clé `anon` sont en dur dans `app.js` (la clé `anon` est publique par design ; la RLS et le mot de passe admin assurent la sécurité).
- **GitHub Pages** sert les fichiers statiques depuis la branche `main`
- Adresse du jeu : **https://jdh.christophe.online/** — sous-domaine de `christophe.online`, branché par un CNAME vers `dafawn.github.io`. Le fichier `CNAME` à la racine du dépôt est ce qui indique à GitHub Pages de répondre sous ce nom : **ne le supprimez pas**.
- L'ancienne adresse `dafawn.github.io/jeu-des-heures/` redirige vers le domaine personnalisé, les liens déjà partagés restent valides.
- Un push sur `main` suffit à publier.

## Notes de sécurité connues

- L'identité d'un joueur est son nom, saisi librement : n'importe qui peut taper le nom d'un autre et modifier son pari avant la fermeture. Le code à 4 chiffres protège l'accès au groupe, pas les paris individuels.
- `verify_admin_password` est appelable par `anon` (c'est le portail d'entrée du mode admin) : le mot de passe est donc testable par le réseau et doit être long et aléatoire. Le hachage bcrypt rend chaque tentative coûteuse (~100 ms), ce qui limite fortement une attaque par force brute.
- Le bot Discord (`dafawn/jdh_bot`) était un **second moteur de jeu**, avec sa propre base et son propre classement — donc un second registre de points, incompatible avec celui-ci. Il a été retiré en août 2026 : base vidée, dépôt archivé. **Le Jeu des Heures ne vit plus que dans cette application.**
