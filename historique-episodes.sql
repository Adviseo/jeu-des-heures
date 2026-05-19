-- =====================================================
-- Historique Épisodes 1–12 — Jeu des Heures Koh Lanta 2026
-- À coller dans Supabase → SQL Editor → Run
-- =====================================================

-- 1. Joueurs gagnants
INSERT INTO public.players (name) VALUES
  ('Astrid'),
  ('Mathis'),
  ('Colette'),
  ('Shakapix'),
  ('Catampiresunsea'),
  ('Fireflo'),
  ('Nono'),
  ('Vavann')
ON CONFLICT (name) DO NOTHING;

-- 2. Épisodes terminés
INSERT INTO public.episodes (number, status, announced_at) VALUES
  (1,  'completed', '2026-03-03T23:29:00+01:00'),
  (2,  'completed', '2026-03-10T23:16:00+01:00'),
  (3,  'completed', '2026-03-17T23:22:00+01:00'),
  (4,  'completed', '2026-03-24T23:12:00+01:00'),
  (5,  'completed', '2026-03-31T23:17:00+02:00'),
  (6,  'completed', '2026-04-07T23:22:00+02:00'),
  (7,  'completed', '2026-04-14T23:15:00+02:00'),
  (8,  'completed', '2026-04-21T23:03:00+02:00'),
  (9,  'completed', '2026-04-28T23:22:00+02:00'),
  (10, 'completed', '2026-05-05T23:09:00+02:00'),
  (11, 'completed', '2026-05-12T23:13:00+02:00'),
  (12, 'completed', '2026-05-19T23:16:00+02:00')
ON CONFLICT (number) DO UPDATE SET
  status      = 'completed',
  announced_at = EXCLUDED.announced_at;

-- 3. Pronostics gagnants (un par épisode)
WITH
  ep AS (SELECT id, number FROM public.episodes WHERE number BETWEEN 1 AND 12),
  pl AS (SELECT id, name FROM public.players WHERE name IN (
    'Astrid','Mathis','Colette','Shakapix',
    'Catampiresunsea','Fireflo','Nono','Vavann'
  ))
INSERT INTO public.predictions
  (episode_id, player_id, predicted_time, is_winner, is_tout_pile, points_won)
SELECT
  e.id,
  p.id,
  v.predicted_time::TIME,
  true,
  v.is_tout_pile,
  v.points_won
FROM (VALUES
  (1,  'Astrid',          '23:38', false, 1),
  (2,  'Mathis',          '23:31', false, 1),
  (3,  'Colette',         '23:22', true,  2),
  (4,  'Shakapix',        '23:21', false, 1),
  (5,  'Catampiresunsea', '23:18', false, 1),
  (6,  'Fireflo',         '23:22', true,  2),
  (7,  'Nono',            '23:43', false, 1),
  (8,  'Catampiresunsea', '23:13', false, 1),
  (9,  'Vavann',          '23:22', true,  2),
  (10, 'Nono',            '23:15', false, 1),
  (11, 'Catampiresunsea', '23:17', false, 1),
  (12, 'Catampiresunsea', '23:22', false, 1)
) AS v(ep_num, player_name, predicted_time, is_tout_pile, points_won)
JOIN ep e ON e.number = v.ep_num
JOIN pl p ON p.name  = v.player_name
ON CONFLICT (episode_id, player_id) DO UPDATE SET
  predicted_time = EXCLUDED.predicted_time,
  is_winner      = true,
  is_tout_pile   = EXCLUDED.is_tout_pile,
  points_won     = EXCLUDED.points_won;
