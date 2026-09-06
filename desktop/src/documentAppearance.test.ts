import { describe, expect, it } from 'vitest';
import { documentAppearance, documentStyleVariables } from './documentAppearance';

describe('document presentation', () => {
  it('keeps each document independent and handles legacy settings', () => {
    const styles = documentAppearance();
    styles.invoices.accentColor = '#793c32';
    expect(styles.quotes.accentColor).toBe('#134d33');
    expect(styles.accounts.accentColor).toBe('#134d33');
    expect(documentAppearance({ invoices: styles.invoices }).invoices.accentColor).toBe('#793c32');
  });
  it('maintains contrast for a light color and avoids injecting CSS', () => {
    const styles = documentAppearance();
    styles.invoices.accentColor = '#ffffff';
    const variables = documentStyleVariables(styles.invoices) as Record<string,string>;
    expect(variables['--document-on-accent']).toBe('#111111');
    expect(variables['--document-ink']).toBe('rgb(115,115,115)');
    expect(documentAppearance({ invoices: { ...styles.invoices, accentColor: 'url(https://invalid)' } }).invoices.accentColor).toBe('#134d33');
  });
});
