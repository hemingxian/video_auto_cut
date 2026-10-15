BEGIN;

WITH indexable AS (
    SELECT an.analysis_id
    FROM analysis an
    JOIN analysis_chunk ac ON ac.analysis_id = an.analysis_id
    WHERE an.analysis_status = 'completed'
      AND an.chunk_count > 0
    GROUP BY an.analysis_id, an.chunk_count
    HAVING count(*) = an.chunk_count
)
UPDATE analysis an
SET vector_sync_status = 'completed', last_error = NULL, updated_at = now()
FROM indexable ready
WHERE an.analysis_id = ready.analysis_id;

UPDATE analysis_chunk ac
SET cloud_vector_status = 'completed', updated_at = now()
FROM analysis an
WHERE ac.analysis_id = an.analysis_id
  AND an.analysis_status = 'completed'
  AND an.vector_sync_status = 'completed';

INSERT INTO vector_outbox(analysis_id, status, next_retry_at)
SELECT analysis_id, 'completed', now()
FROM analysis
WHERE analysis_status = 'completed' AND vector_sync_status = 'completed'
ON CONFLICT(analysis_id) DO UPDATE SET
    status = 'completed', last_error = NULL, updated_at = now();

COMMIT;
