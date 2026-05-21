-- =========================================================
-- LE JEU DES HEURES — Politiques RLS (Row Level Security)
-- À exécuter dans Supabase → SQL Editor APRÈS supabase-setup.sql
--
-- Principe : lecture publique, écriture contrôlée
-- =========================================================

-- ========== 1. Activer RLS sur toutes les tables ==========

ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;

-- ========== 2. Table PLAYERS ==========

-- Lecture : tout le monde peut voir les joueurs
DROP POLICY IF EXISTS "players_select_all" ON public.players;
CREATE POLICY "players_select_all"
    ON public.players FOR SELECT
    TO anon, authenticated
    USING (true);

-- Insertion : tout le monde peut créer un joueur (son propre nom)
DROP POLICY IF EXISTS "players_insert_all" ON public.players;
CREATE POLICY "players_insert_all"
    ON public.players FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

-- Modification/Suppression : personne via l'API directe
-- (les admins gèrent via des RPC SECURITY DEFINER si besoin)

-- ========== 3. Table EPISODES ==========

-- Lecture : tout le monde peut voir les épisodes
DROP POLICY IF EXISTS "episodes_select_all" ON public.episodes;
CREATE POLICY "episodes_select_all"
    ON public.episodes FOR SELECT
    TO anon, authenticated
    USING (true);

-- Insertion/Modification/Suppression : via RPC admin uniquement
-- On crée des fonctions SECURITY DEFINER pour les opérations admin

-- Fonction admin : créer un épisode
CREATE OR REPLACE FUNCTION public.admin_create_episode(
    ep_number INTEGER,
    ep_bet_code TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    new_id UUID;
BEGIN
    -- Clôturer tous les épisodes actifs
    UPDATE public.episodes SET status = 'completed' WHERE status = 'active';
    -- Créer le nouveau
    INSERT INTO public.episodes (number, status, bet_code)
    VALUES (ep_number, 'active', ep_bet_code)
    RETURNING id INTO new_id;
    RETURN new_id;
END;
$$;

-- Fonction admin : clôturer un épisode (FIN)
CREATE OR REPLACE FUNCTION public.admin_close_episode(
    ep_id UUID,
    announced_timestamp TIMESTAMP WITH TIME ZONE
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.episodes
    SET status = 'completed', announced_at = announced_timestamp
    WHERE id = ep_id;
END;
$$;

-- Fonction admin : mettre à jour le bet_code d'un épisode
CREATE OR REPLACE FUNCTION public.admin_update_bet_code(
    ep_id UUID,
    new_code TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.episodes SET bet_code = new_code WHERE id = ep_id;
END;
$$;

-- Fonction admin : réactiver un épisode
CREATE OR REPLACE FUNCTION public.admin_reactivate_episode(
    ep_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.episodes
    SET status = 'active', announced_at = NULL
    WHERE id = ep_id;
END;
$$;

-- Fonction admin : activer un épisode par numéro (switch)
CREATE OR REPLACE FUNCTION public.admin_activate_episode(
    ep_number INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_id UUID;
BEGIN
    -- Chercher l'épisode
    SELECT id INTO target_id FROM public.episodes WHERE number = ep_number;

    IF target_id IS NULL THEN
        -- Créer et activer
        UPDATE public.episodes SET status = 'completed' WHERE status = 'active';
        INSERT INTO public.episodes (number, status) VALUES (ep_number, 'active')
        RETURNING id INTO target_id;
    ELSE
        -- Désactiver les autres, activer celui-ci
        UPDATE public.episodes SET status = 'completed' WHERE id != target_id AND status = 'active';
        UPDATE public.episodes SET status = 'active' WHERE id = target_id;
    END IF;

    RETURN target_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_episode(INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_episode(INTEGER, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_close_episode(UUID, TIMESTAMP WITH TIME ZONE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_close_episode(UUID, TIMESTAMP WITH TIME ZONE) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_update_bet_code(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_bet_code(UUID, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_reactivate_episode(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_episode(UUID) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_activate_episode(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_activate_episode(INTEGER) TO anon, authenticated;

-- ========== 4. Table PREDICTIONS ==========

-- Lecture : tout le monde peut voir les pronostics
DROP POLICY IF EXISTS "predictions_select_all" ON public.predictions;
CREATE POLICY "predictions_select_all"
    ON public.predictions FOR SELECT
    TO anon, authenticated
    USING (true);

-- Insertion : autorisée si l'épisode est actif
-- (le trigger check_bet_window s'occupe de la fenêtre horaire)
DROP POLICY IF EXISTS "predictions_insert_active_episode" ON public.predictions;
CREATE POLICY "predictions_insert_active_episode"
    ON public.predictions FOR INSERT
    TO anon, authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.episodes e
            WHERE e.id = episode_id AND e.status = 'active'
        )
    );

-- Modification : autorisée pour tout le monde si l'épisode est actif
-- (le trigger check_bet_window s'occupe de la fenêtre horaire de 21h à 22h)
DROP POLICY IF EXISTS "predictions_update_active_episode" ON public.predictions;
CREATE POLICY "predictions_update_active_episode"
    ON public.predictions FOR UPDATE
    TO anon, authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.episodes e
            WHERE e.id = episode_id AND e.status = 'active'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.episodes e
            WHERE e.id = episode_id AND e.status = 'active'
        )
    );

-- Modification : via RPC admin uniquement (pour mettre à jour les scores)
-- Fonction admin : mettre à jour les résultats d'une prédiction
CREATE OR REPLACE FUNCTION public.admin_update_prediction_result(
    pred_id UUID,
    p_points_won INTEGER,
    p_is_winner BOOLEAN,
    p_is_tout_pile BOOLEAN,
    p_gap_minutes INTEGER DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.predictions
    SET points_won = p_points_won,
        is_winner = p_is_winner,
        is_tout_pile = p_is_tout_pile,
        gap_minutes = p_gap_minutes
    WHERE id = pred_id;
END;
$$;

-- Fonction admin : supprimer une prédiction
CREATE OR REPLACE FUNCTION public.admin_delete_prediction(pred_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.predictions WHERE id = pred_id;
END;
$$;

-- Fonction admin : supprimer toutes les prédictions d'un épisode
CREATE OR REPLACE FUNCTION public.admin_delete_episode_predictions(ep_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.predictions WHERE episode_id = ep_id;
END;
$$;

-- Fonction admin : réinitialiser les scores (sans supprimer l'historique)
CREATE OR REPLACE FUNCTION public.admin_reset_leaderboard()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.predictions
    SET points_won = 0,
        is_winner = false,
        is_tout_pile = false,
        gap_minutes = NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_prediction_result(UUID, INTEGER, BOOLEAN, BOOLEAN, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_prediction_result(UUID, INTEGER, BOOLEAN, BOOLEAN, INTEGER) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_delete_prediction(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_prediction(UUID) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_delete_episode_predictions(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_episode_predictions(UUID) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_reset_leaderboard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reset_leaderboard() TO anon, authenticated;

-- ========== 5. Note de sécurité ==========
-- Les fonctions admin RPC sont appelables par anon car l'app n'utilise pas
-- Supabase Auth. La protection repose sur verify_admin_password() côté client.
-- 
-- Pour une sécurité renforcée, migrer vers Supabase Auth :
-- 1. Créer un utilisateur admin dans Supabase Auth
-- 2. Ajouter un check auth.uid() dans chaque fonction admin
-- 3. Retirer les GRANT anon sur les fonctions admin
