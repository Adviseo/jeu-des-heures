-- Ajout colonne gap_minutes + rétrofit épisodes 1–12
-- Supabase → SQL Editor → Run

ALTER TABLE public.predictions ADD COLUMN IF NOT EXISTS gap_minutes INTEGER;

-- Écarts épisodes 1–12 (predicted_time - announced_time, en minutes)
-- Ep1  Astrid         23:38 - 23:29 = 9 min
-- Ep2  Mathis         23:31 - 23:16 = 15 min
-- Ep3  Colette        23:22 - 23:22 = 0 (tout pile)
-- Ep4  Shakapix       23:21 - 23:12 = 9 min
-- Ep5  Catampiresunsea 23:18 - 23:17 = 1 min
-- Ep6  Fireflo        23:22 - 23:22 = 0 (tout pile)
-- Ep7  Nono           23:43 - 23:15 = 28 min
-- Ep8  Catampiresunsea 23:13 - 23:03 = 10 min
-- Ep9  Vavann         23:22 - 23:22 = 0 (tout pile)
-- Ep10 Nono           23:15 - 23:09 = 6 min
-- Ep11 Catampiresunsea 23:17 - 23:13 = 4 min
-- Ep12 Catampiresunsea 23:22 - 23:16 = 6 min

UPDATE public.predictions p
SET gap_minutes = v.gap
FROM (VALUES
  (1,  'Astrid',           9),
  (2,  'Mathis',          15),
  (3,  'Colette',          0),
  (4,  'Shakapix',         9),
  (5,  'Catampiresunsea',  1),
  (6,  'Fireflo',          0),
  (7,  'Nono',            28),
  (8,  'Catampiresunsea', 10),
  (9,  'Vavann',           0),
  (10, 'Nono',             6),
  (11, 'Catampiresunsea',  4),
  (12, 'Catampiresunsea',  6)
) AS v(ep_num, player_name, gap)
JOIN public.episodes  e  ON e.number   = v.ep_num
JOIN public.players   pl ON pl.name    = v.player_name
WHERE p.episode_id = e.id
  AND p.player_id  = pl.id;

-- Vérification : doit retourner 12 lignes avec gap non null
SELECT e.number, pl.name, p.predicted_time, p.gap_minutes
FROM public.predictions p
JOIN public.episodes e  ON e.id  = p.episode_id
JOIN public.players  pl ON pl.id = p.player_id
WHERE p.is_winner = true
ORDER BY e.number;
