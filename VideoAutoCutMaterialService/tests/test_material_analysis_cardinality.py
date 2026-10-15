"""The exact lateral join used by material reads must not multiply material rows."""
from pathlib import Path
import re


def material_analysis_join():
    source = (Path(__file__).parents[1] / 'app' / 'repository.py').read_text(encoding='utf-8')
    joins = re.findall(r'LEFT JOIN LATERAL \(\s*SELECT candidate\.\* FROM analysis candidate.*?\) an ON TRUE', source, re.S)
    assert len(joins) == 10
    assert len(set(joins)) == 1
    assert 'LEFT JOIN analysis an' not in source
    return joins[0]


def test_material_reads_share_a_single_deterministic_analysis_selection():
    join = material_analysis_join()
    assert "candidate.analysis_status='completed'" in join
    assert "candidate.chunk_count > 0" in join
    assert "FROM analysis_chunk chunk" in join
    assert 'candidate.updated_at DESC, candidate.analysis_id DESC' in join
    assert 'LIMIT 1' in join


def regression_sql():
    join = material_analysis_join()
    return f"""
BEGIN;
CREATE TEMP TABLE material (material_id text, asset_id text, asset_version int);
CREATE TEMP TABLE analysis (analysis_id text, asset_id text, asset_version int,
 analysis_status text, updated_at timestamptz, chunk_count int);
CREATE TEMP TABLE analysis_chunk (analysis_id text, chunk_id text);
INSERT INTO material VALUES ('m1','a1',1),('m2','a2',1),('m3','a3',1),
 ('m4','a4',1),('m5','a5',1),('m6','a6',1),('m7','a7',1);
INSERT INTO analysis VALUES
 ('old-completed','a1',1,'completed','2026-01-01',1),
 ('new-pending','a1',1,'pending','2026-02-01',0),
 ('tie-a','a2',1,'completed','2026-01-01',1),
 ('tie-b','a2',1,'completed','2026-01-01',1),
 ('valid-old','a4',1,'completed','2026-01-01',1),
 ('incomplete-new','a4',1,'completed','2026-02-01',2),
 ('empty-completed','a5',1,'completed','2026-01-01',0),
 ('only-pending','a6',1,'pending','2026-01-01',0),
 ('wrong-version','a7',2,'completed','2026-01-01',1);
INSERT INTO analysis_chunk VALUES ('old-completed','c1'),('tie-a','c2'),
 ('tie-b','c3'),('valid-old','c4'),('incomplete-new','c5'),('wrong-version','c6');
CREATE TEMP TABLE actual AS SELECT m.material_id,an.analysis_id FROM material m {join};
DO $$ BEGIN
 IF (SELECT count(*) FROM actual) <> 7 THEN RAISE EXCEPTION 'multiplied rows'; END IF;
 IF (SELECT analysis_id FROM actual WHERE material_id='m1') <> 'old-completed' THEN RAISE EXCEPTION 'lost completed analysis'; END IF;
 IF (SELECT analysis_id FROM actual WHERE material_id='m2') <> 'tie-b' THEN RAISE EXCEPTION 'unstable tie'; END IF;
 IF (SELECT analysis_id FROM actual WHERE material_id='m3') IS NOT NULL THEN RAISE EXCEPTION 'missing analysis'; END IF;
 IF (SELECT analysis_id FROM actual WHERE material_id='m4') <> 'valid-old' THEN RAISE EXCEPTION 'accepted incomplete chunks'; END IF;
 IF (SELECT analysis_id FROM actual WHERE material_id='m5') IS NOT NULL THEN RAISE EXCEPTION 'accepted empty completed'; END IF;
 IF (SELECT analysis_id FROM actual WHERE material_id='m6') <> 'only-pending' THEN RAISE EXCEPTION 'lost real pending status'; END IF;
 IF (SELECT analysis_id FROM actual WHERE material_id='m7') IS NOT NULL THEN RAISE EXCEPTION 'wrong asset version selected'; END IF;
END $$;
ROLLBACK;
"""


if __name__ == '__main__':
    print(regression_sql())
