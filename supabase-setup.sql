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
-- Stocké en clair dans la fonction (SECURITY DEFINER → non lisible par anon)
CREATE OR REPLACE FUNCTION public.verify_admin_password(pw text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN pw = 'Catastophe0410!';
END;
$$;

REVOKE ALL ON FUNCTION public.verify_admin_password(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_password(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;

-- 6. Realtime : activer les notifications sur les 3 tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.episodes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.predictions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.players;
