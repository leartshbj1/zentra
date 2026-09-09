WITH pending AS (
    SELECT c.sequence,c.after_json,
           json_extract(COALESCE(c.after_json,c.before_json),'$.id') AS document_id,
           json_extract(COALESCE(c.after_json,c.before_json),'$.project_id') AS project_id
    FROM business_sync_changes c JOIN business_sync_binding b ON b.generation=c.generation
    WHERE c.table_name='attachments'
      AND json_extract(COALESCE(c.after_json,c.before_json),'$.entity_type')='project'
      AND NOT EXISTS(SELECT 1 FROM business_sync_receipts r
                     WHERE r.generation=c.generation AND r.transaction_id=c.transaction_id
                       AND r.acknowledged_through>=c.sequence)
), latest AS (
    SELECT p.* FROM pending p
    WHERE p.sequence=(SELECT MAX(x.sequence) FROM pending x WHERE x.document_id=p.document_id)
)
SELECT a.id AS document_id,a.project_id,
       CASE WHEN ? AND l.sequence IS NULL THEN 'synced' ELSE 'upload' END AS state,
       NULL AS last_error
FROM attachments a LEFT JOIN latest l ON l.document_id=a.id
WHERE a.entity_type='project'
UNION ALL
SELECT l.document_id,l.project_id,'delete',NULL
FROM latest l WHERE l.after_json IS NULL
  AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.id=l.document_id)
ORDER BY project_id,document_id
