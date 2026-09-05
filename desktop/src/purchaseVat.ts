/** Supplier rates are independent of the buyer's sales rates and right to deduct. */
export function purchaseVatOptions(vatRegistered: boolean, configuredRatesBp: number[]) {
  const configured = configuredRatesBp.filter((rate) => Number.isInteger(rate) && rate >= 0 && rate <= 10_000);
  return [...new Set([...(vatRegistered ? [] : [0]), ...configured, 0, 260, 380, 810])];
}

export const nonRegisteredPurchaseVatHint = 'Recopiez le prix hors taxe et la TVA indiqués par le fournisseur. Sans assujettissement ni profil TVA couvrant la date de l’achat, cette TVA reste comprise dans le coût et n’est pas récupérable.';

export function purchaseCostCategories(configured: string[]) {
  const categories = [...new Set(configured.map((value) => value.trim()).filter(Boolean))];
  return categories.length ? categories : ['Marchandises', 'Prestations de services', 'Autres achats'];
}
