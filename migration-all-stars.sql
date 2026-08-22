-- =========================================================
-- LE JEU DES HEURES — Migration « All Stars »
-- =========================================================
-- Appliquée en production le 21/08/2026. Ce fichier est le reflet
-- exact de ce qui tourne : il est ré-exécutable sans dommage.
--
-- Contenu :
--   1. Notion de saison — le classement repart de zéro
--   2. Coefficient par épisode — les épreuves reines
--   3. Axe horaire continu — la soirée peut déborder sur le lendemain
--   4. Fermeture des fonctions admin — mot de passe vérifié EN BASE
--   5. Clôture atomique — vainqueur et barème calculés côté serveur
--
-- ⚠️ Ne touche PAS à public.verify_admin_password() : le mot de passe
--    en place reste inchangé. Ne le redéfinissez pas ici.
-- =========================================================


-- =========================================================
-- 1. SAISONS
-- =========================================================

ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS season INTEGER NOT NULL DEFAULT 1;

-- La contrainte d'unicité devient (saison, numéro).
-- Sans ça, impossible de créer l'épisode 1 d'une nouvelle saison :
-- les 16 épisodes de la précédente occupaient déjà les numéros 1 à 16.
ALTER TABLE public.episodes DROP CONSTRAINT IF EXISTS episodes_number_key;
ALTER TABLE public.episodes DROP CONSTRAINT IF EXISTS episodes_season_number_key;
ALTER TABLE public.episodes
  ADD CONSTRAINT episodes_season_number_key UNIQUE (season, number);

CREATE INDEX IF NOT EXISTS idx_episodes_season ON public.episodes (season, number);


-- =========================================================
-- 2. COEFFICIENT PAR ÉPISODE (épreuves reines)
-- =========================================================
-- 1 = épisode normal · 2 = épreuve d'orientation · 3 = finale
-- Le coefficient ne multiplie que la victoire de base : jamais le
-- tout pile, jamais le feu sacré.

ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS multiplier SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE public.episodes DROP CONSTRAINT IF EXISTS episodes_multiplier_check;
ALTER TABLE public.episodes
  ADD CONSTRAINT episodes_multiplier_check CHECK (multiplier BETWEEN 1 AND 5);


-- =========================================================
-- 3. FEU SACRÉ + GARDE-FOU SUR LE NOM
-- =========================================================

ALTER TABLE public.predictions
  ADD COLUMN IF NOT EXISTS combo_bonus SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_name_len_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_name_len_check
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 24);


-- =========================================================
-- 4. HEURE → « MINUTE DE JEU »
-- =========================================================
-- La soirée déborde sur le lendemain : une annonce à 00:07 doit se
-- situer APRÈS un pari à 23:55. On projette donc tout sur un axe
-- continu où 00:00–11:59 appartient au lendemain (+24 h).

CREATE OR REPLACE FUNCTION public.game_minutes(t TIME)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT (EXTRACT(HOUR FROM t)::INTEGER * 60)
         + EXTRACT(MINUTE FROM t)::INTEGER
         + CASE WHEN EXTRACT(HOUR FROM t) < 12 THEN 1440 ELSE 0 END;
$$;

GRANT EXECUTE ON FUNCTION public.game_minutes(TIME) TO anon, authenticated;


-- =========================================================
-- 5. SUPPRESSION DES ANCIENNES FONCTIONS ADMIN
-- =========================================================
-- Indispensable : ajouter un paramètre créerait une surcharge, et les
-- anciennes signatures — ouvertes à anon sans mot de passe — resteraient
-- appelables depuis la console du navigateur.

DROP FUNCTION IF EXISTS public.admin_create_episode(INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.admin_close_episode(UUID, TIMESTAMP WITH TIME ZONE);
DROP FUNCTION IF EXISTS public.admin_update_bet_code(UUID, TEXT);
DROP FUNCTION IF EXISTS public.admin_reactivate_episode(UUID);
DROP FUNCTION IF EXISTS public.admin_activate_episode(INTEGER);
DROP FUNCTION IF EXISTS public.admin_update_prediction_result(UUID, INTEGER, BOOLEAN, BOOLEAN, INTEGER);
DROP FUNCTION IF EXISTS public.admin_delete_prediction(UUID);
DROP FUNCTION IF EXISTS public.admin_delete_episode_predictions(UUID);
DROP FUNCTION IF EXISTS public.admin_reset_leaderboard();


-- =========================================================
-- 6. GARDE ADMIN
-- =========================================================

CREATE OR REPLACE FUNCTION public.assert_admin(p_pw TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_pw IS NULL OR NOT public.verify_admin_password(p_pw) THEN
        RAISE EXCEPTION 'Accès administrateur refusé';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_admin(TEXT) FROM PUBLIC;


-- =========================================================
-- 7. FONCTIONS ADMIN — toutes protégées par mot de passe
-- =========================================================

CREATE OR REPLACE FUNCTION public.admin_create_episode(
    p_pw TEXT, p_season INTEGER, p_number INTEGER,
    p_bet_code TEXT DEFAULT NULL, p_multiplier SMALLINT DEFAULT 1
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id UUID;
BEGIN
    PERFORM public.assert_admin(p_pw);
    UPDATE public.episodes SET status = 'completed' WHERE status = 'active';
    INSERT INTO public.episodes (season, number, status, bet_code, multiplier)
    VALUES (p_season, p_number, 'active', p_bet_code, COALESCE(p_multiplier, 1))
    RETURNING id INTO new_id;
    RETURN new_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_activate_episode(
    p_pw TEXT, p_season INTEGER, p_number INTEGER
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target_id UUID;
BEGIN
    PERFORM public.assert_admin(p_pw);
    SELECT id INTO target_id FROM public.episodes
    WHERE season = p_season AND number = p_number;

    UPDATE public.episodes SET status = 'completed'
    WHERE status = 'active' AND (target_id IS NULL OR id <> target_id);

    IF target_id IS NULL THEN
        INSERT INTO public.episodes (season, number, status)
        VALUES (p_season, p_number, 'active') RETURNING id INTO target_id;
    ELSE
        UPDATE public.episodes SET status = 'active' WHERE id = target_id;
    END IF;
    RETURN target_id;
END; $$;

-- Le coefficient se fige dès le premier pari : on ne change pas
-- l'enjeu d'une soirée après l'ouverture des paris.
CREATE OR REPLACE FUNCTION public.admin_set_multiplier(
    p_pw TEXT, p_ep_id UUID, p_multiplier SMALLINT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM public.assert_admin(p_pw);
    IF EXISTS (SELECT 1 FROM public.predictions WHERE episode_id = p_ep_id) THEN
        RAISE EXCEPTION 'Coefficient verrouillé : des paris sont déjà enregistrés sur cet épisode';
    END IF;
    UPDATE public.episodes SET multiplier = p_multiplier WHERE id = p_ep_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_update_bet_code(
    p_pw TEXT, p_ep_id UUID, p_code TEXT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM public.assert_admin(p_pw);
    UPDATE public.episodes SET bet_code = p_code WHERE id = p_ep_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_reactivate_episode(p_pw TEXT, p_ep_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM public.assert_admin(p_pw);
    UPDATE public.episodes SET status = 'completed' WHERE status = 'active' AND id <> p_ep_id;
    UPDATE public.predictions
    SET points_won = 0, is_winner = FALSE, is_tout_pile = FALSE, combo_bonus = 0
    WHERE episode_id = p_ep_id;
    UPDATE public.episodes SET status = 'active', announced_at = NULL WHERE id = p_ep_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_delete_prediction(p_pw TEXT, p_pred_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM public.assert_admin(p_pw);
    DELETE FROM public.predictions WHERE id = p_pred_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_delete_episode_predictions(p_pw TEXT, p_ep_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM public.assert_admin(p_pw);
    DELETE FROM public.predictions WHERE episode_id = p_ep_id;
END; $$;

-- Remise à zéro d'UNE saison : les autres ne sont jamais touchées.
CREATE OR REPLACE FUNCTION public.admin_reset_leaderboard(p_pw TEXT, p_season INTEGER)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM public.assert_admin(p_pw);
    UPDATE public.predictions p
    SET points_won = 0, is_winner = FALSE, is_tout_pile = FALSE,
        gap_minutes = NULL, combo_bonus = 0
    WHERE EXISTS (SELECT 1 FROM public.episodes e
                  WHERE e.id = p.episode_id AND e.season = p_season);
END; $$;


-- =========================================================
-- 8. CLÔTURE ATOMIQUE + BARÈME CALCULÉ EN BASE
-- =========================================================
-- Un seul appel, une seule transaction : une coupure réseau ne peut
-- plus laisser l'épisode à moitié scoré, et le client ne dicte plus
-- ni le vainqueur ni les points.
--
-- Barème :
--   victoire            = 1 × coefficient de l'épisode
--   tout pile           = +1   (jamais multiplié)
--   feu sacré 2e        = +1   (jamais multiplié)
--   feu sacré 3e et +   = +2   (plafond)
--
-- Le calcul vit dans close_episode_scored (testable, JAMAIS exposée à
-- anon) ; admin_close_episode n'est que le contrôle d'accès.

CREATE OR REPLACE FUNCTION public.close_episode_scored(
    p_ep_id UUID, p_announced TIMESTAMP WITH TIME ZONE DEFAULT NULL
)
RETURNS TABLE (
    winner_name TEXT, winner_time TIME, points INTEGER,
    tout_pile BOOLEAN, combo SMALLINT, all_over BOOLEAN,
    closed_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_season INTEGER; v_number INTEGER; v_multiplier SMALLINT; v_status TEXT;
    v_announced TIMESTAMP WITH TIME ZONE; v_end_min INTEGER;
    v_win_pred UUID; v_win_player UUID; v_win_min INTEGER;
    v_all_over BOOLEAN := FALSE; v_tout_pile BOOLEAN := FALSE;
    v_streak SMALLINT := 0; v_combo SMALLINT := 0; v_points INTEGER;
    v_prev RECORD;
BEGIN
    -- FOR UPDATE : deux clics simultanés sur FIN ne peuvent pas
    -- produire deux clôtures concurrentes.
    SELECT season, number, multiplier, status, announced_at
      INTO v_season, v_number, v_multiplier, v_status, v_announced
    FROM public.episodes WHERE id = p_ep_id FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Épisode introuvable'; END IF;
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Épisode déjà clôturé à %', v_announced;
    END IF;

    -- p_announced NULL = l'horloge du serveur fait foi
    v_announced := COALESCE(p_announced, now());
    v_end_min := public.game_minutes((v_announced AT TIME ZONE 'Europe/Paris')::TIME);

    -- Le plus proche sans être dépassé
    SELECT id, player_id, public.game_minutes(predicted_time)
      INTO v_win_pred, v_win_player, v_win_min
    FROM public.predictions
    WHERE episode_id = p_ep_id AND public.game_minutes(predicted_time) >= v_end_min
    ORDER BY public.game_minutes(predicted_time) ASC LIMIT 1;

    -- Personne au-dessus : toutes les heures sont dépassées,
    -- la plus tardive l'emporte.
    IF v_win_pred IS NULL THEN
        SELECT id, player_id, public.game_minutes(predicted_time)
          INTO v_win_pred, v_win_player, v_win_min
        FROM public.predictions WHERE episode_id = p_ep_id
        ORDER BY public.game_minutes(predicted_time) DESC LIMIT 1;
        v_all_over := (v_win_pred IS NOT NULL);
    END IF;

    -- Écart enregistré pour TOUT LE MONDE : la précision moyenne
    -- devient une vraie statistique et le départage sépare enfin
    -- deux joueurs à zéro victoire.
    UPDATE public.predictions
    SET points_won = 0, is_winner = FALSE, is_tout_pile = FALSE, combo_bonus = 0,
        gap_minutes = abs(public.game_minutes(predicted_time) - v_end_min)
    WHERE episode_id = p_ep_id;

    IF v_win_pred IS NOT NULL THEN
        v_tout_pile := (v_win_min = v_end_min);

        -- Feu sacré : victoires consécutives immédiatement précédentes,
        -- dans la même saison.
        FOR v_prev IN
            SELECT p.player_id
            FROM public.episodes e
            JOIN public.predictions p ON p.episode_id = e.id AND p.is_winner
            WHERE e.season = v_season AND e.number < v_number AND e.status = 'completed'
            ORDER BY e.number DESC
        LOOP
            IF v_prev.player_id = v_win_player THEN v_streak := v_streak + 1;
            ELSE EXIT; END IF;
        END LOOP;

        v_combo := LEAST(v_streak, 2);
        v_points := (1 * GREATEST(v_multiplier, 1))
                  + (CASE WHEN v_tout_pile THEN 1 ELSE 0 END) + v_combo;

        UPDATE public.predictions
        SET points_won = v_points, is_winner = TRUE,
            is_tout_pile = v_tout_pile, combo_bonus = v_combo
        WHERE id = v_win_pred;
    END IF;

    UPDATE public.episodes
    SET status = 'completed', announced_at = v_announced WHERE id = p_ep_id;

    RETURN QUERY
    SELECT pl.name, p.predicted_time, p.points_won, p.is_tout_pile,
           p.combo_bonus, v_all_over, v_announced
    FROM public.predictions p JOIN public.players pl ON pl.id = p.player_id
    WHERE p.id = v_win_pred;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_close_episode(
    p_pw TEXT, p_ep_id UUID, p_announced TIMESTAMP WITH TIME ZONE DEFAULT NULL
)
RETURNS TABLE (
    winner_name TEXT, winner_time TIME, points INTEGER,
    tout_pile BOOLEAN, combo SMALLINT, all_over BOOLEAN,
    closed_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM public.assert_admin(p_pw);
    RETURN QUERY SELECT * FROM public.close_episode_scored(p_ep_id, p_announced);
END; $$;


-- =========================================================
-- 9. PERMISSIONS
-- =========================================================
-- Les fonctions admin_* restent appelables par anon (l'app n'utilise
-- pas Supabase Auth) mais chacune exige désormais le mot de passe.

DO $$
DECLARE fn TEXT;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure::TEXT FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'admin\_%'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', fn);
    END LOOP;
END; $$;

-- Ni le garde ni le moteur de calcul ne sont joignables directement.
REVOKE ALL ON FUNCTION public.assert_admin(TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.close_episode_scored(UUID, TIMESTAMP WITH TIME ZONE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_episode_scored(UUID, TIMESTAMP WITH TIME ZONE) FROM anon, authenticated;

-- ⚠️ verify_admin_password reste appelable par anon : c'est le portail
-- d'entrée du mode admin. Le mot de passe est donc testable par le
-- réseau — il doit être long et aléatoire, pas un mot du dictionnaire.


-- =========================================================
-- 10. VÉRIFICATIONS
-- =========================================================

-- Doit montrer 16 épisodes en saison 1
SELECT season, count(*) AS episodes, min(number) AS du, max(number) AS au
FROM public.episodes GROUP BY season ORDER BY season;

-- L'axe horaire doit ordonner 23:55 AVANT 00:07
SELECT public.game_minutes('23:55') AS m_2355,
       public.game_minutes('00:07') AS m_0007,
       public.game_minutes('23:55') < public.game_minutes('00:07') AS ordre_correct;

-- Toutes les fonctions admin doivent prendre p_pw en premier argument
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'admin%'
ORDER BY p.proname;


-- =========================================================
-- 11. VUE DE LECTURE + FENÊTRE DE PARIS
-- =========================================================
-- Note : les paris à l'aveugle (heures masquées jusqu'à la fermeture)
-- ont été essayés puis abandonnés. Se placer juste devant ou juste
-- derrière un autre joueur EST le plaisir du jeu ; et avec l'unicité
-- des heures, masquer les paris transformait la mise en devinette par
-- essais-erreurs. Le déséquilibre du dernier parieur est traité en
-- resserrant la fenêtre.

-- La vue reste le chemin de lecture : le nom du joueur et la saison y
-- sont déjà joints, ce qui évite au client toute jointure imbriquée.
CREATE OR REPLACE VIEW public.predictions_visible AS
SELECT
    p.id, p.episode_id, p.player_id,
    pl.name AS player_name,
    e.season, e.number AS episode_number, e.multiplier,
    TRUE AS revealed,
    p.predicted_time,
    p.points_won, p.is_winner, p.is_tout_pile, p.combo_bonus, p.gap_minutes, p.created_at
FROM public.predictions p
JOIN public.episodes e  ON e.id = p.episode_id
JOIN public.players  pl ON pl.id = p.player_id;

GRANT SELECT ON public.predictions_visible TO anon, authenticated;
GRANT SELECT ON public.predictions TO anon, authenticated;

-- Fenêtre de paris : 21h00 → 21h30.
-- Sur les 23 paris réellement enregistrés la saison passée : médiane à
-- 21:09, 83 % avant 21:30, aucun après 21:44. Le dernier quart d'heure
-- ne servait qu'à attendre que les autres se découvrent.
-- ⚠️ À changer ici ET dans BET_WINDOW_END côté app.js.
CREATE OR REPLACE FUNCTION public.check_bet_window()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    paris_time TIME;
    episode_status TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.predicted_time = NEW.predicted_time THEN
        RETURN NEW;
    END IF;

    SELECT e.status INTO episode_status
    FROM public.episodes e
    WHERE e.id = NEW.episode_id;

    IF episode_status != 'active' THEN
        RAISE EXCEPTION 'L''épisode n''est pas actif';
    END IF;

    paris_time := (now() AT TIME ZONE 'Europe/Paris')::TIME;
    IF paris_time < '21:00:00' OR paris_time >= '21:30:00' THEN
        RAISE EXCEPTION 'Les paris ne sont autorisés qu''entre 21h00 et 21h30';
    END IF;

    RETURN NEW;
END;
$$;


-- =========================================================
-- 12. MOT DE PASSE ADMIN HACHÉ (bcrypt)
-- =========================================================
-- Le mot de passe était comparé à une chaîne littérale dans le corps
-- d'une fonction SQL : toute personne ayant un accès lecture au projet
-- pouvait le lire.
--
-- Cette migration ne lit PAS le mot de passe en place : l'ancienne
-- implémentation est renommée et sert de repli tant qu'aucun hash n'est
-- enregistré. L'accès admin n'est donc jamais interrompu.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Coffre applicatif : RLS activée SANS aucune politique, donc illisible
-- par anon. Seules les fonctions SECURITY DEFINER y accèdent.
CREATE TABLE IF NOT EXISTS public.app_secrets (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_secrets FROM anon, authenticated;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'verify_admin_password'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'verify_admin_password_legacy'
    ) THEN
        ALTER FUNCTION public.verify_admin_password(text)
            RENAME TO verify_admin_password_legacy;
    END IF;
END $$;

REVOKE ALL ON FUNCTION public.verify_admin_password_legacy(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_admin_password(pw text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_hash TEXT;
BEGIN
    IF pw IS NULL OR length(pw) = 0 THEN
        RETURN FALSE;
    END IF;

    SELECT value INTO v_hash FROM public.app_secrets WHERE key = 'admin_pw_hash';

    IF v_hash IS NOT NULL THEN
        -- bcrypt : la comparaison prend ~100 ms, ce qui rend une attaque
        -- par force brute via le réseau très coûteuse.
        RETURN extensions.crypt(pw, v_hash) = v_hash;
    END IF;

    -- Aucun hash posé : on garde le comportement existant.
    RETURN public.verify_admin_password_legacy(pw);
END;
$$;

REVOKE ALL ON FUNCTION public.verify_admin_password(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_password(text) TO anon, authenticated;

-- ---------------------------------------------------------
-- À FAIRE UNE FOIS, À LA MAIN, dans Supabase → SQL Editor.
-- Choisissez un mot de passe long et aléatoire (il reste testable par
-- le réseau), et ne le committez jamais :
--
--   INSERT INTO public.app_secrets (key, value)
--   VALUES ('admin_pw_hash',
--           extensions.crypt('VOTRE-NOUVEAU-MOT-DE-PASSE', extensions.gen_salt('bf', 10)))
--   ON CONFLICT (key) DO UPDATE
--     SET value = EXCLUDED.value, updated_at = now();
--
-- Une fois le hash posé et l'accès admin vérifié, l'ancienne fonction
-- ne sert plus à rien et peut disparaître avec son mot de passe en clair :
--
--   DROP FUNCTION public.verify_admin_password_legacy(text);
-- ---------------------------------------------------------


-- =========================================================
-- 13. DURCISSEMENT SIGNALÉ PAR L'ADVISOR SUPABASE
-- =========================================================

-- predictions_visible s'exécutait avec les droits de son propriétaire
-- (comportement par défaut d'une vue), donc en contournant la RLS des
-- tables sous-jacentes. Sans conséquence tant que leurs politiques de
-- lecture sont ouvertes — mais si on resserrait un jour la RLS sur
-- predictions, la vue continuerait de tout exposer sans prévenir.
ALTER VIEW public.predictions_visible SET (security_invoker = on);

-- search_path figé : sans lui, une fonction résout ses appels selon le
-- search_path de l'appelant, qui peut y glisser un schéma contenant
-- une fonction homonyme.
ALTER FUNCTION public.game_minutes(TIME) SET search_path = public;
ALTER FUNCTION public.check_bet_window() SET search_path = public;
ALTER FUNCTION public.get_server_time()  SET search_path = public;

-- ---------------------------------------------------------
-- Ce que l'advisor signale encore, et qui est VOULU :
--
-- · « RLS Enabled No Policy » sur app_secrets — c'est exactement le
--   dispositif : RLS active sans aucune politique = personne ne lit la
--   table, sauf les fonctions SECURITY DEFINER.
--
-- · « Public Can Execute SECURITY DEFINER Function » sur les fonctions
--   admin_* — l'app n'utilise pas Supabase Auth, donc ces fonctions
--   doivent rester appelables par anon. La protection n'est pas le
--   GRANT mais le mot de passe vérifié à l'intérieur de chacune.
-- ---------------------------------------------------------
