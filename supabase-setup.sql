-- =========================================================
-- LE JEU DES HEURES — Schéma Supabase
-- À exécuter dans Supabase → SQL Editor (une fois)
-- Idempotent : peut être ré-exécuté sans casser l'existant
-- =========================================================

-- 1. Table des Joueurs
CREATE TABLE IF NOT EXISTS public.players (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_name ON public.players (name);

-- 2. Table des Épisodes
CREATE TABLE IF NOT EXISTS public.episodes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    number INTEGER UNIQUE NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed')) NOT NULL,
    announced_at TIMESTAMP WITH TIME ZONE,
    bet_code TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Table des Pronostics
CREATE TABLE IF NOT EXISTS public.predictions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE NOT NULL,
    player_id UUID REFERENCES public.players(id) ON DELETE CASCADE NOT NULL,
    predicted_time TIME NOT NULL,
    points_won INTEGER DEFAULT 0 NOT NULL,
    is_tout_pile BOOLEAN DEFAULT FALSE NOT NULL,
    is_winner BOOLEAN DEFAULT FALSE NOT NULL,
    gap_minutes INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT unique_prediction_per_episode UNIQUE (episode_id, player_id),
    CONSTRAINT unique_time_per_episode UNIQUE (episode_id, predicted_time)
);

-- 4. Fonction : heure serveur (déjà utilisée par app.js)
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TABLE (server_time TIMESTAMP WITH TIME ZONE, time_only TIME)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY SELECT now(), (now() AT TIME ZONE 'Europe/Paris')::TIME;
END;
$$;

-- 5. Fonction : vérification du mot de passe admin
-- ⚠️ IMPORTANT : Changez le mot de passe ci-dessous avant d'exécuter !
-- Le mot de passe doit être unique et ne JAMAIS être commité dans Git.
-- Alternative recommandée : utiliser Supabase Vault pour stocker le secret.
CREATE OR REPLACE FUNCTION public.verify_admin_password(pw text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- ⚠️ REMPLACEZ ce mot de passe par le vôtre avant exécution
    RETURN pw = 'CHANGEZ_MOI_avant_deploiement';
END;
$$;

-- 6. Fonction serveur : valider la fenêtre de pari (21h-22h)
-- Appelée avant chaque INSERT de prédiction pour empêcher les paris hors créneau
CREATE OR REPLACE FUNCTION public.check_bet_window()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    paris_time TIME;
    episode_status TEXT;
BEGIN
    -- Vérifier que l'épisode est actif
    SELECT e.status INTO episode_status
    FROM public.episodes e
    WHERE e.id = NEW.episode_id;

    IF episode_status != 'active' THEN
        RAISE EXCEPTION 'L''épisode n''est pas actif';
    END IF;

    -- Vérifier la fenêtre horaire (21h00 - 22h00 heure de Paris)
    paris_time := (now() AT TIME ZONE 'Europe/Paris')::TIME;
    IF paris_time < '21:00:00' OR paris_time >= '22:00:00' THEN
        RAISE EXCEPTION 'Les paris ne sont autorisés qu''entre 21h00 et 22h00';
    END IF;

    RETURN NEW;
END;
$$;

-- Appliquer le trigger sur les insertions de prédictions
DROP TRIGGER IF EXISTS trg_check_bet_window ON public.predictions;
CREATE TRIGGER trg_check_bet_window
    BEFORE INSERT ON public.predictions
    FOR EACH ROW
    EXECUTE FUNCTION public.check_bet_window();

REVOKE ALL ON FUNCTION public.verify_admin_password(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_password(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;

-- 7. Realtime : activer les notifications sur les 3 tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.episodes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.predictions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.players;
