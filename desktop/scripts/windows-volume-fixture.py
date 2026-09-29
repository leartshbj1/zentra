"""Deterministic, credential-free data for a NEW package-owned test profile only."""
from contextlib import closing
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

PURPOSE = 'zentra-windows-volume-1909'
COMPANY = 'Atelier Volume 1909 - FICTIF'
COUNT = 5000
STAMP = '2026-01-01T09:00:00Z'
LOCAL = {'license_state', 'device_number_ranges', 'project_sync_binding',
         'project_document_sync', 'project_document_tombstones', 'project_sync_events', 'active_timers'}


def require(value, message):
    if not value:
        raise ValueError(message)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def owned_profile(profile):
    profile = Path(profile)
    require(profile.is_absolute() and profile.name == 'profile', 'Expected an absolute isolated profile')
    require(profile.parent.name.startswith('zentra-volume-1909-'), 'Unexpected test root')
    require(all(not p.is_symlink() for p in [profile, *profile.parents]), 'Symbolic links are forbidden')
    require(profile.resolve() == profile, 'Profile must be a canonical path')
    marker = json.loads((profile.parent / 'volume-run.json').read_text(encoding='utf-8'))
    require(marker.get('purpose') == PURPOSE and marker.get('synthetic') is True, 'Missing ownership marker')
    require(marker.get('profile') == str(profile), 'Ownership marker points elsewhere')
    require(marker.get('initializedByPackage') is True, 'Only a package-initialized database may be seeded')
    require((profile / 'helvichantier.sqlite3').is_file(), 'Database does not exist')
    for pattern in ('*account*protected*', '*license*protected*', '*mail*protected*', '*smtp*', '*session*'):
        require(not list(profile.glob(pattern)), 'A connected or licensed profile must never be used')
    return profile, marker


def readonly(profile):
    return sqlite3.connect((profile / 'helvichantier.sqlite3').as_uri() + '?mode=ro', uri=True)


def snapshot(profile):
    profile, marker = owned_profile(profile)
    with closing(readonly(profile)) as db:
        db.execute('PRAGMA query_only=ON')
        require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Database integrity failure')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Foreign key failure')
        db.row_factory = sqlite3.Row
        tables, local = {}, {}
        names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for name in names:
            require(re.fullmatch('[a-zA-Z0-9_]+', name), 'Unexpected table name')
            values = sorted(json.dumps(dict(row), ensure_ascii=False, sort_keys=True,
                                       separators=(',', ':'), default=lambda blob: {'hex': blob.hex()})
                            for row in db.execute(f'SELECT * FROM "{name}"'))
            entry = {'rows': len(values), 'sha256': hashlib.sha256('\n'.join(values).encode()).hexdigest()}
            (local if name in LOCAL or name.startswith('company_local_') else tables)[name] = entry
        require(not db.execute('SELECT 1 FROM license_state LIMIT 1').fetchone(), 'A licence was added')
        unbalanced = db.execute('SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id HAVING SUM(debit_cents)<>SUM(credit_cents)').fetchall()
        require(not unbalanced, 'Unbalanced fixture journal')
        schema = db.execute('PRAGMA user_version').fetchone()[0]
    files = {}
    for path in sorted((profile / 'attachments').rglob('*')):
        require(not path.is_symlink(), 'Attachment links are forbidden')
        if path.is_file():
            files[path.relative_to(profile / 'attachments').as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {'synthetic': True, 'schema': schema, 'tables': tables, 'localTables': local,
            'attachments': files, 'integrity': 'ok', 'foreignKeys': 'ok', 'balancedJournal': True}


def unchanged(before, after):
    # Device clocks/caches can legitimately change on startup. Keep their counts
    # and hashes in both proofs; never silently exclude a business table.
    return all(before[k] == after[k] for k in ('schema', 'tables', 'attachments', 'integrity', 'foreignKeys', 'balancedJournal'))


def seed(profile, deadline=None):
    profile, marker = owned_profile(profile)
    require(not (profile.parent / 'fixture.json').exists(), 'Never reseed a fixture')
    require(not any(p.is_file() for p in (profile / 'attachments').rglob('*')), 'Attachments must be empty')
    started = time.monotonic()
    def check_time():
        if deadline is not None:
            require(time.monotonic() < deadline, 'Fixture deadline exceeded')
    check_time()
    database = profile / 'helvichantier.sqlite3'
    with closing(sqlite3.connect(database.as_uri() + '?mode=rw', uri=True, timeout=2)) as db:
        db.execute('PRAGMA foreign_keys=ON')
        require(db.execute('PRAGMA user_version').fetchone()[0] == marker['schema'], 'Unexpected database schema')
        # These are the same connection-local functions used by SQLite guards.
        # No trigger is dropped or altered. This connection exists only while
        # seeding an empty, marked fixture, while the packaged app is stopped.
        db.create_function('zentra_company_write_allowed', 0, lambda: 1)
        db.create_function('zentra_installation_id', 0, lambda: '00000000-0000-4000-8000-000000001909')
        db.create_function('zentra_sha256', 1, lambda value: hashlib.sha256(str(value).encode()).hexdigest())
        db.create_function('zentra_company_logo_key', 1, lambda value: value)
        empty = ['settings', 'clients', 'projects', 'quotes', 'quote_items', 'invoices', 'invoice_items',
                 'payments', 'journal_entries', 'journal_lines', 'accounts', 'accounting_periods',
                 'attachments', 'license_state', 'company_local_binding']
        available = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in empty:
            if table in available:
                require(db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == 0,
                        f'Refusing a populated profile: {table}')
        columns = {}
        def insert(table, **values):
            if table not in columns:
                columns[table] = {r[1] for r in db.execute(f'PRAGMA table_info("{table}")')}
            for key in ('created_at', 'updated_at'):
                if key in columns[table]:
                    values.setdefault(key, STAMP)
            require(set(values) <= columns[table], 'Unsupported fixture schema')
            db.execute(f'INSERT INTO "{table}" ({",".join(values)}) VALUES ({",".join("?" for _ in values)})', tuple(values.values()))
        def ident(key):
            return str(uuid.uuid5(uuid.NAMESPACE_URL, 'https://example.invalid/zentra-volume-1909/' + key))
        try:
            db.execute('BEGIN IMMEDIATE')
            insert('settings', id=1, onboarding_completed=1, company_name=COMPANY, currency='CHF',
                   country='CH', noga_section='F', noga_division='43', activity_description='Entreprise fictive de mesure locale',
                   extra_settings_json='{}')
            accounts = {}
            for code, name, kind, normal, section in [
                ('1020', 'Banque fictive', 'asset', 'debit', 'current_assets'),
                ('1100', 'Creances fictives', 'asset', 'debit', 'current_assets'),
                ('3200', 'Ventes fictives', 'revenue', 'credit', 'net_revenue')]:
                accounts[code] = ident('account-' + code)
                insert('accounts', id=accounts[code], code=code, name=name, account_type=kind,
                       normal_balance=normal, report_section=section)
            if db.execute('SELECT COUNT(*) FROM accounting_settings').fetchone()[0]:
                db.execute('UPDATE accounting_settings SET enabled=1,ar_account_id=?,revenue_account_id=?,bank_account_id=? WHERE id=1',
                           (accounts['1100'], accounts['3200'], accounts['1020']))
            else:
                insert('accounting_settings', id=1, enabled=1, ar_account_id=accounts['1100'],
                       revenue_account_id=accounts['3200'], bank_account_id=accounts['1020'])
            # A fixed period makes the accounting read independent of the runner date.
            insert('accounting_periods', id=ident('period'), name='Recette 2020-2026', date_from='2020-01-01', date_to='2026-12-31')
            clients, projects = [], []
            for i in range(500):
                client = ident(f'client-{i}'); clients.append(client)
                insert('clients', id=client, name=f'Client fictif {i:04}', email=f'client-{i}@example.invalid')
            for i in range(100):
                project = ident(f'project-{i}'); projects.append(project)
                insert('projects', id=project, client_id=clients[i], name=f'Projet fictif {i:03}', code=f'VOL-{i:03}')
            for i in range(COUNT):
                if i % 100 == 0: check_time()
                when = (date(2020, 1, 1) + timedelta(days=i // 2)).isoformat()
                client, project = clients[i % 500], projects[i % 100]
                quote, invoice = ident(f'quote-{i}'), ident(f'invoice-{i}')
                paid = [0, 40000, 80000][i % 3]
                common = dict(client_id=client, project_id=project, issue_date=when,
                              subtotal_cents=80000, total_cents=80000, title=f'Document fictif {i:05}')
                insert('quotes', id=quote, **common)
                insert('invoices', id=invoice, quote_id=quote, due_date=when, paid_cents=paid, **common)
                for j in range(8):
                    for table, parent, key in [('quote_items', 'quote_id', quote), ('invoice_items', 'invoice_id', invoice)]:
                        insert(table, id=ident(f'{table}-{i}-{j}'), **{parent: key}, position=j,
                               description=f'Prestation fictive {j+1}', unit_price_cents=10000,
                               line_net_cents=10000, line_total_cents=10000)
                db.execute("UPDATE quotes SET number=?,status='accepte' WHERE id=?", (f'D-VOL-{i:05}', quote))
                db.execute('UPDATE invoices SET number=?,status=? WHERE id=?',
                           (f'F-VOL-{i:05}', ['emise', 'partiellement_payee', 'payee'][i % 3], invoice))
                entries = [('issue', 80000, '1100', '3200', invoice)]
                if paid:
                    payment = ident(f'payment-{i}')
                    insert('payments', id=payment, invoice_id=invoice, date=when, amount_cents=paid,
                           method='virement', reference='FICTIF - AUCUNE OPERATION REELLE')
                    entries.append(('receipt', paid, '1020', '1100', payment))
                for event, amount, debit, credit, source in entries:
                    entry = ident(f'journal-{i}-{event}')
                    # Synthetic manual history: not a test of real issuance/payment workflows.
                    insert('journal_entries', id=entry, number=f'VOL-{i}-{event}', entry_date=when,
                           description='Historique volumetrique fictif', source_type='manual',
                           source_id=source, source_event='fixture')
                    for side, account in [('debit', debit), ('credit', credit)]:
                        insert('journal_lines', id=ident(f'{side}-{i}-{event}'), journal_entry_id=entry,
                               account_id=accounts[account], **{side + '_cents': amount},
                               currency='CHF', project_id=project, client_id=client)
            payloads = {}
            for i in range(3):
                name = f'volume-piece-{i}.txt'
                content = f'Piece fictive deterministe {i}. Aucun document client.\n'.encode()
                payloads[name] = content
                insert('attachments', id=ident(name), project_id=projects[i], original_name=name,
                       stored_name=name, mime_type='text/plain', size_bytes=len(content),
                       sha256=hashlib.sha256(content).hexdigest())
            require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Fixture foreign key failure')
            require(db.execute('SELECT SUM(debit_cents-credit_cents) FROM journal_lines').fetchone()[0] == 0, 'Fixture journal mismatch')
            db.commit()
        except BaseException:
            db.rollback()
            raise
        (profile / 'attachments').mkdir(exist_ok=True)
        for name, content in payloads.items():
            with (profile / 'attachments' / name).open('xb') as stream:
                stream.write(content)
        counts = {table: db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                  for table in ['clients', 'projects', 'quotes', 'quote_items', 'invoices', 'invoice_items', 'payments', 'journal_entries', 'journal_lines', 'attachments']}
    proof = {'synthetic': True, 'companyName': COMPANY, 'accountOrLicenseAdded': False,
             'counts': counts, 'generationSeconds': time.monotonic() - started,
             'scope': 'Direct SQL test history, not a business workflow validation'}
    write_json(profile.parent / 'fixture.json', proof)
    return proof
