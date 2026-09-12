import { describe, expect, it } from 'vitest';
import { contactFormIssue, contactNativeIssue } from './contactFormValidation';
const client = { contactPerson: 'Camille', company: '', street: 'Rue du test', postalCode: '1000', city: 'Lausanne', country: 'CH', email: '' };
const supplier = { name: 'Fournisseur', email: '', iban: '', paymentTermsDays: '30' };
describe('contact form guidance', () => {
  it('accepts a person or a company without inventing a contact', () => {
    expect(contactFormIssue('client', client)).toBeNull();
    expect(contactFormIssue('client', { ...client, contactPerson: '', company: 'Entreprise' })).toBeNull();
    expect(contactFormIssue('client', { ...client, contactPerson: ' ', company: ' ' })?.field).toBe('contactPerson');
  });
  it.each(['street', 'postalCode', 'city'])('targets missing %s', field => expect(contactFormIssue('client', { ...client, [field]: '' })?.field).toBe(field));
  it('accepts international addresses and explicit foreign countries', () => {
    expect(contactFormIssue('client', { ...client, postalCode: 'SW1A 1AA', country: 'GB' })).toBeNull();
    expect(contactFormIssue('client', { ...client, country: '__other', countryCustom: 'es' })).toBeNull();
    expect(contactFormIssue('client', { ...client, country: '__other', countryCustom: 'Espagne' })?.field).toBe('countryCustom');
  });
  it('checks optional e-mails in place', () => {
    expect(contactFormIssue('client', { ...client, email: 'incomplet' })?.field).toBe('email');
    expect(contactFormIssue('supplier', { ...supplier, email: 'contact@example.ch' })).toBeNull();
  });
  it('keeps supplier address, IDE and bank information optional', () => expect(contactFormIssue('supplier', supplier)).toBeNull());
  it('requires a real supplier name', () => expect(contactFormIssue('supplier', { ...supplier, name: ' ' })?.field).toBe('name'));
  it.each(['', '30,5', '30.5', '-1', '1e2', '9007199254740992'])('never rounds or replaces invalid days %s', paymentTermsDays => expect(contactFormIssue('supplier', { ...supplier, paymentTermsDays })?.field).toBe('paymentTermsDays'));
  it.each(['0', '30', ' 60 ', '366'])('preserves native nonnegative whole days %s', paymentTermsDays => expect(contactFormIssue('supplier', { ...supplier, paymentTermsDays })).toBeNull());
  it('checks optional IBAN checksum while accepting spaces', () => {
    expect(contactFormIssue('supplier', { ...supplier, iban: 'CH93 0076 2011 6238 5295 7' })).toBeNull();
    expect(contactFormIssue('supplier', { ...supplier, iban: 'CH93 0076 2011 6238 5295 6' })?.field).toBe('iban');
  });
  it('translates storage field names to the editable fields', () => {
    expect(contactNativeIssue('supplier', 'payment_terms_days doit être un nombre entier positif ou nul.')?.field).toBe('paymentTermsDays');
    expect(contactNativeIssue('supplier', 'contact_name ne peut pas dépasser 200 caractères.')?.field).toBe('contactName');
    expect(contactNativeIssue('client', 'address_line1 invalide')?.field).toBe('street');
    expect(contactNativeIssue('client', 'Interruption temporaire')).toBeNull();
  });
});
