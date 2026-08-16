-- Round 4: three minimal house layouts — quiet options beside the seven
-- archetypes. Colors are brand tokens; each needs at most 2 picks.
INSERT INTO layout (id, team_id, slug, name, config, created_at, updated_at) VALUES
('seed_layout_min_corner', 'seed_team_house', 'minimal-corner', 'Minimal — corner lockup',
 '{"cells":[{"x":0,"y":0,"w":1,"h":1}],"lockup":"corner","labels":false}',
 '2026-08-16T11:40:00.000Z', '2026-08-16T11:40:00.000Z'),
('seed_layout_min_title', 'seed_team_house', 'minimal-title', 'Minimal — image + title only',
 '{"cells":[{"x":0,"y":0,"w":1,"h":1}],"lockup":"none","labels":false,"shapes":[{"kind":"gradient","x":0,"y":0.55,"w":1,"h":0.45,"color":"paper","opacity":0.85,"angle":90}],"texts":[{"content":{"role":"projectTitle"},"font":"title","x":0.06,"y":0.78,"w":0.85,"color":"ink"}]}',
 '2026-08-16T11:40:00.000Z', '2026-08-16T11:40:00.000Z'),
('seed_layout_min_pair', 'seed_team_house', 'minimal-pair', 'Minimal — quiet pair',
 '{"cells":[{"x":0,"y":0,"w":0.5,"h":1,"feather":["right"]},{"x":0.5,"y":0,"w":0.5,"h":1}],"lockup":"bottom","labels":false}',
 '2026-08-16T11:40:00.000Z', '2026-08-16T11:40:00.000Z');
