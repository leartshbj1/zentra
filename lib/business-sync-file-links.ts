// Resolve only the portable final file name from legacy absolute device paths.
// The original path is never used to construct a remote storage key.
const field = (name: string) => `json_extract(row_json,'$.${name}')`;
const normalized = (path: string) => `replace(${path},char(92),'/')`;
const basename = (path: string) =>
  `substr(${path},length(rtrim(${path},replace(${path},'/','')))+1)`;
export const businessFileLinksSql = `WITH
  versions AS MATERIALIZED (SELECT table_name,row_json FROM business_sync_versions WHERE transfer_id=?1 AND organization_id=?2),
  legacy AS MATERIALIZED (SELECT table_name,row_json,${normalized(`CASE table_name WHEN 'settings' THEN ${field('logo_path')} ELSE ${field('stored_path')} END`)} path
    FROM versions WHERE table_name IN ('settings','payroll_document_imports')),
  refs AS MATERIALIZED (
    SELECT table_name,${field('id')} id,'attachments/'||${field('stored_name')} path,${field('sha256')} sha,${field('size_bytes')} size,0 bad FROM versions WHERE table_name='attachments'
    UNION ALL SELECT table_name,${field('id')},'attachments/branding/'||${field('file_name')},${field('sha256')},${field('byte_size')},0 FROM versions WHERE table_name='company_brand_assets'
    UNION ALL SELECT table_name,${field('id')},'attachments/payroll-imports/'||${basename('path')},${field('file_sha256')},${field('file_size')},
      ('/'||path||'/') LIKE '%/../%' OR substr('/'||path,-length('/payroll-imports/'||${basename('path')})) IS NOT '/payroll-imports/'||${basename('path')}
      FROM legacy WHERE table_name='payroll_document_imports'
    UNION ALL SELECT table_name,'1','attachments/branding/'||${basename('path')},NULL,NULL,('/'||path||'/') LIKE '%/../%'
      FROM legacy WHERE table_name='settings' AND path IS NOT NULL AND trim(path)<>''
    UNION ALL SELECT table_name,${field('id')},'exports/'||${field('file_name')},
      CASE WHEN table_name='vat_return_exports' THEN ${field('xml_sha256')} END,NULL,0
      FROM versions WHERE table_name IN ('vat_return_exports','closing_package_exports'))
  SELECT r.table_name,r.id FROM refs r LEFT JOIN business_sync_file_entries f ON f.transfer_id=?1 AND f.path=r.path
  WHERE r.bad OR f.path IS NULL OR (r.sha IS NOT NULL AND r.sha<>'' AND r.sha<>f.sha256) OR (r.size IS NOT NULL AND r.size<>f.size_bytes) LIMIT 1`;
