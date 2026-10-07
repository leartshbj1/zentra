import { validateCompanyConfiguration } from './country-config';
import type { CompanyConfiguration } from './types';
import type { ErpState } from './runtime-types';
import type { ErpDelta } from './runtime-sync';
import { taxAssessmentProof, type IssuedInvoice } from './invoicing';

/** Network views have no need for an EIN. The private stored configuration is unchanged. */
export function publicCompanyConfiguration(configuration: CompanyConfiguration): CompanyConfiguration {
  const { ein: _ein, ...publicFields } = configuration;
  return validateCompanyConfiguration(publicFields);
}

function publicInvoice(invoice: IssuedInvoice): IssuedInvoice {
  return { ...invoice, companyConfiguration: publicCompanyConfiguration(invoice.companyConfiguration), taxAssessment: taxAssessmentProof(invoice.taxAssessment) };
}

/** Redact both current and historical company profiles, without changing money or tax evidence. */
export function publicErpState(state: ErpState): ErpState {
  const copy = structuredClone(state);
  return { ...copy, configuration: publicCompanyConfiguration(copy.configuration), invoices: copy.invoices.map(publicInvoice) };
}

export function publicErpDelta(delta: ErpDelta): ErpDelta {
  const copy = structuredClone(delta);
  return {
    ...copy,
    events: copy.events.map(event => ({
      ...event,
      header: { ...event.header, configuration: publicCompanyConfiguration(event.header.configuration) },
      changes: event.changes.map(change => change.kind === 'invoice'
        ? { ...change, payload: publicInvoice(change.payload as IssuedInvoice) }
        : change),
    })),
  };
}
