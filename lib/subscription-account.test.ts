import { DatabaseSync } from 'node:sqlite';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const runtime=vi.hoisted(()=>({database:vi.fn()}));
vi.mock('./runtime',()=>({database:runtime.database}));
import { linkPaidCheckoutAccount,linkPaidCompany } from './subscription-account';
let db:DatabaseSync;
const owner={userId:'verified-owner-id',email:'client@example.ch',displayName:'Client Zentra'};
function prepare(sql:string) {
  let values:unknown[]=[];
  return {sql,get values(){return values;},bind(...args:unknown[]){values=args;return this;},
    async first(){return db.prepare(sql).get(...values as never[]) || null;},
    async run(){return db.prepare(sql).run(...values as never[]);}};
}
beforeEach(()=>{
  db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE subscriptions(subscription_id TEXT PRIMARY KEY,checkout_session_id TEXT,customer_name TEXT,last_paid_invoice_id TEXT,entitlement_valid_until INTEGER,seat_limit INTEGER);
    CREATE TABLE checkout_attempts(checkout_session_id TEXT PRIMARY KEY,account_user_id TEXT,account_email TEXT,account_name TEXT);
    CREATE TABLE organizations(organization_id TEXT PRIMARY KEY,name TEXT,subscription_id TEXT UNIQUE,created_by_user_id TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE organization_members(membership_id TEXT PRIMARY KEY,organization_id TEXT,user_id TEXT,email TEXT,display_name TEXT,role TEXT,joined_at INTEGER,revoked_at INTEGER,UNIQUE(organization_id,user_id));`);
  db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?,?,?)').run('sub_one','cs_one','Entreprise','in_paid',Math.floor(Date.now()/1000)+3600,3);
  db.prepare('INSERT INTO checkout_attempts VALUES(?,?,?,?)').run('cs_one',owner.userId,owner.email,owner.displayName);
  runtime.database.mockReturnValue({prepare,async batch(statements:ReturnType<typeof prepare>[]){db.exec('BEGIN');try {const result=statements.map(s=>db.prepare(s.sql).run(...s.values as never[]));db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}});
});
afterEach(()=>db.close());
describe('account subscription activation',()=>{
  it('automatically links the paid checkout to its authenticated owner, once across concurrent retries',async()=>{
    const [a,b]=await Promise.all([linkPaidCheckoutAccount('sub_one'),linkPaidCheckoutAccount('sub_one')]);
    expect(a).toEqual(b);expect(a?.name).toBe('Entreprise');
    expect(db.prepare('SELECT COUNT(*) AS count FROM organizations').get()?.count).toBe(1);
    expect(db.prepare('SELECT user_id,email,role FROM organization_members').get()).toMatchObject({user_id:owner.userId,email:owner.email,role:'owner'});
  });
  it('does not activate an unpaid, expired, or unbound checkout',async()=>{
    db.exec('UPDATE subscriptions SET last_paid_invoice_id=NULL');expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();
    db.exec("UPDATE subscriptions SET last_paid_invoice_id='in_paid',entitlement_valid_until=1");expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();
    db.exec(`UPDATE subscriptions SET entitlement_valid_until=${Math.floor(Date.now()/1000)+1000}; DELETE FROM checkout_attempts;`);
    expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();expect(db.prepare('SELECT COUNT(*) AS count FROM organizations').get()?.count).toBe(0);
  });
  it('never takes ownership based on an identical email',async()=>{
    await linkPaidCheckoutAccount('sub_one');
    await expect(linkPaidCompany('sub_one',{...owner,userId:'another-id'})).rejects.toThrow('autre compte');
    expect(db.prepare('SELECT COUNT(*) AS count FROM organization_members').get()?.count).toBe(1);
  });
  it('preserves activation of settled legacy subscriptions with no seat limit',async()=>{
    db.exec('UPDATE subscriptions SET seat_limit=NULL');
    expect(await linkPaidCompany('sub_one',owner)).toMatchObject({name:'Entreprise'});
  });
  it('handles invoice-paid before checkout-completed and does not recreate revoked access',async()=>{
    db.exec('UPDATE subscriptions SET checkout_session_id=NULL');expect(await linkPaidCheckoutAccount('sub_one')).toBeNull();
    db.exec("UPDATE subscriptions SET checkout_session_id='cs_one'");await linkPaidCheckoutAccount('sub_one');
    db.exec('UPDATE organization_members SET revoked_at=123');await linkPaidCheckoutAccount('sub_one');
    expect(db.prepare('SELECT revoked_at FROM organization_members').get()?.revoked_at).toBe(123);
  });
});
