"""Inspect isolated installer-test profiles; never connect to a user profile."""

import hashlib
import json
from pathlib import Path
import sqlite3
import sys


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def rows(connection):
    result = {}
    for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        if name in {'installation_secrets'}:
            continue
        quoted = '"' + name.replace('"', '""') + '"'
        values = sorted(json.dumps(row, ensure_ascii=False, default=lambda value: {'hex': value.hex()}) for row in connection.execute('SELECT * FROM ' + quoted))
        result[name] = {'rows': len(values), 'sha256': hashlib.sha256('\n'.join(values).encode()).hexdigest()}
    return result


def seed(connection, profile):
    """Create business fixtures through the existing schema and all its guards."""
    stamp = '2026-09-07T12:00:00Z'

    def insert(table, **values):
        columns = {row[1] for row in connection.execute('PRAGMA table_info(' + table + ')')}
        for key in ('created_at', 'updated_at'):
            if key in columns:
                values[key] = stamp
        connection.execute('INSERT INTO ' + table + '(' + ','.join(values) + ') VALUES (' + ','.join('?' for _ in values) + ')', tuple(values.values()))

    insert('clients', id='qa-client', name='Client fictif migration')
    insert('projects', id='qa-project', client_id='qa-client', name='Projet fictif migration')
    document = dict(client_id='qa-client', project_id='qa-project', title='Document fictif', issue_date='2026-09-07', subtotal_cents=100000, vat_cents=8100, total_cents=108100, notes='Première ligne\nSeconde ligne')
    insert('quotes', id='qa-quote', **document)
    insert('invoices', id='qa-invoice', quote_id='qa-quote', **document)
    item = dict(description='Prestation fictive', unit_price_cents=100000, vat_bp=810, line_net_cents=100000, line_vat_cents=8100, line_total_cents=108100)
    insert('quote_items', id='qa-quote-item', quote_id='qa-quote', **item)
    insert('invoice_items', id='qa-invoice-item', invoice_id='qa-invoice', **item)
    connection.execute("UPDATE quotes SET number='D-2026-000041',status='accepte' WHERE id='qa-quote'")
    connection.execute("UPDATE invoices SET number='F-2026-000012',status='partiellement_payee',paid_cents=30000 WHERE id='qa-invoice'")
    insert('payments', id='qa-payment', invoice_id='qa-invoice', date='2026-09-07', amount_cents=30000, method='bank', reference='F-2026-000012')
    insert('employees', id='qa-employee', name='Collaborateur fictif', monthly_salary_cents=600000)
    attachment = b'Plan fictif pour validation de migration.\n'
    stored = profile / 'attachments/qa-plan.txt'
    stored.parent.mkdir(exist_ok=True)
    stored.write_bytes(attachment)
    insert('attachments', id='qa-attachment', project_id='qa-project', original_name='plan.txt', stored_name='qa-plan.txt', mime_type='text/plain', size_bytes=len(attachment), sha256=hashlib.sha256(attachment).hexdigest())
    for code, name, kind, normal, section in [('1020','Banque','asset','debit','current_assets'),('1100','Créances','asset','debit','current_assets'),('2200','TVA','liability','credit','short_term_liabilities'),('3200','Ventes','revenue','credit','net_revenue')]:
        insert('accounts', id='qa-account-' + code, code=code, name=name, account_type=kind, normal_balance=normal, report_section=section)
    insert('journal_entries', id='qa-sale', number='J-2026-000001', entry_date='2026-09-07', description='Vente fictive', source_type='invoice', source_id='qa-invoice', source_event='issued')
    insert('journal_entries', id='qa-receipt', number='J-2026-000002', entry_date='2026-09-07', description='Paiement fictif', source_type='payment', source_id='qa-payment', source_event='recorded')
    for index, (entry, code, debit, credit) in enumerate([('sale','1100',108100,0),('sale','3200',0,100000),('sale','2200',0,8100),('receipt','1020',30000,0),('receipt','1100',0,30000)]):
        insert('journal_lines', id='qa-line-' + str(index), journal_entry_id='qa-' + entry, account_id='qa-account-' + code, debit_cents=debit, credit_cents=credit, currency='CHF', project_id='qa-project', client_id='qa-client')
    insert('number_sequences', document_type='quote', year=2026, next_value=42)
    insert('number_sequences', document_type='invoice', year=2026, next_value=13)
    insert('accounting_sequences', year=2026, next_value=3)
    connection.commit()


def main():
    mode, root, version = sys.argv[1:]
    assert mode in {'probe', 'seed', 'verify'}
    profile = Path(root).resolve()
    # The launcher creates this path on a disposable runner; reject broad paths.
    assert any(part.startswith('zentra-installer-') for part in profile.parts)
    assert profile.name == 'profile'
    expected_schema = {'1.45.0': 58, '1.46.0': 59, '1.46.1': 59}[version]
    database = profile / 'helvichantier.sqlite3'
    identity = profile / 'installation-identity.dpapi'
    uri = database.as_uri() + ('?mode=rw' if mode == 'seed' else '?mode=ro')
    with sqlite3.connect(uri, uri=True, timeout=2) as connection:
        connection.execute('PRAGMA foreign_keys=ON')
        assert connection.execute('PRAGMA user_version').fetchone()[0] == expected_schema
        assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert connection.execute('PRAGMA foreign_key_check').fetchall() == []
        assert identity.is_file() and identity.stat().st_size > 0
        if mode == 'seed':
            assert version == '1.45.0'
            seed(connection, profile)
            baseline = {'tables': rows(connection), 'identitySha256': digest(identity), 'attachmentSha256': digest(profile / 'attachments/qa-plan.txt')}
            (profile / 'upgrade-baseline.json').write_text(json.dumps(baseline, indent=2) + '\n')
        elif mode == 'verify':
            baseline = json.loads((profile / 'upgrade-baseline.json').read_text())
            current = rows(connection)
            assert all(current[name] == data for name, data in baseline['tables'].items())
            assert digest(identity) == baseline['identitySha256']
            assert digest(profile / 'attachments/qa-plan.txt') == baseline['attachmentSha256']
            assert connection.execute('SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id HAVING SUM(debit_cents) != SUM(credit_cents)').fetchall() == []
            assert connection.execute('SELECT COUNT(*) FROM shared_numbering_binding').fetchone()[0] == 0
    print(json.dumps({'version': version, 'schema': expected_schema, 'integrity': 'ok', 'foreignKeysValid': True, 'protectedInstallationIdentityPresent': True, 'mode': mode, 'dataPreserved': mode == 'verify'}))


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, sqlite3.Error, OSError, KeyError, ValueError) as error:
        print(type(error).__name__ + ': isolated profile validation failed', file=sys.stderr)
        sys.exit(2)
